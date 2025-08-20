let currentVideo = '';
let currentFrameIndex = 0;
let totalFrames = 0;
let videoFPS = 30; // Default FPS, will be updated when video loads
let frameRectangles = {}; // Store rectangles per frame - this should persist across frames
let isDrawing = false;
let isResizing = false;
let isDragging = false;
let startX, startY;
let currentRect = null;
let selectedRect = null;
let resizeHandle = null;
let dragOffset = { x: 0, y: 0 };
let imageScale = { x: 1, y: 1, offsetX: 0, offsetY: 0 };

// Video playback state
let isPlaying = false;
let playbackInterval = null;

// Debug: log whenever frameRectangles is modified
console.log('Initialized frameRectangles:', frameRectangles);

async function loadVideos() {
    try {
        const response = await fetch('/get_videos');
        const videos = await response.json();
        const select = document.getElementById('videoSelect');

        videos.forEach(video => {
            const option = document.createElement('option');
            option.value = video;
            option.textContent = video;
            select.appendChild(option);
        });
    } catch (error) {
        showStatus('Error loading videos: ' + error.message, 'error');
    }
}

async function loadVideo() {
    // Hide any existing preview link when loading new video
    hidePreviewLink();
    
    const select = document.getElementById('videoSelect');
    currentVideo = select.value;

    if (!currentVideo) {
        showStatus('Please select a video', 'error');
        return;
    }

    try {
        // First get video info to get FPS
        const videoInfoResponse = await fetch(`/get_video_info/${currentVideo}`);
        const videoInfo = await videoInfoResponse.json();
        videoFPS = videoInfo.fps || 30; // Use actual FPS or default to 30

        // Then extract frames (this returns immediately with job ID for new extractions)
        const response = await fetch(`/extract_frames/${currentVideo}`);
        const data = await response.json();

        if (data.cached) {
            // Frames already exist, load immediately
            totalFrames = data.total;
            finishVideoLoad(data);
        } else if (data.job_id) {
            // Frame extraction started, show progress modal
            showExtractionProgress(data.job_id);
        } else {
            throw new Error(data.error || 'Unknown error during frame extraction');
        }
    } catch (error) {
        showStatus('Error loading video: ' + error.message, 'error');
    }
}

function finishVideoLoad(data) {
    createTimeline();
    showFrame(0);

    document.getElementById('currentFrame').style.display = 'block';
    document.getElementById('timeline').style.display = 'block';

    // Initialize frame size to 1400x800
    const frameDisplay = document.getElementById('frameDisplay');
    if (frameDisplay) {
        frameDisplay.style.width = '1400px';
        frameDisplay.style.height = '800px';
    }

    // Update frame size display after initial load
    setTimeout(() => {
        updateFrameSizeDisplay();
    }, 100);

    // Show appropriate message based on whether frames were cached or extracted
    const statusMessage = data.cached ?
        `Loaded ${totalFrames} frames (cached)` :
        `Extracted ${totalFrames} frames`;
    showStatus(statusMessage, 'success');

    // Load existing rectangles for this video
    loadExistingRectangles();
    
    // Initialize timeline scrubber after a delay to ensure everything is ready
    setTimeout(() => {
        initializeTimelineScrubber();
        console.log('Timeline scrubber initialized with totalFrames:', totalFrames);
    }, 200);
}

function showExtractionProgress(jobId) {
    const modal = document.getElementById('extractionModal');
    modal.style.display = 'flex';

    // Reset progress elements
    document.querySelectorAll('.extraction-step').forEach(step => {
        step.classList.remove('active', 'completed');
    });
    document.getElementById('extractionProgressBarFill').style.width = '0%';
    document.getElementById('totalFramesCount').textContent = 'Calculating...';
    document.getElementById('extractedFramesCount').textContent = '0';
    document.getElementById('extractionSpeed').textContent = '-';
    document.getElementById('extractionProgressText').textContent = 'Starting...';

    // Start polling for progress
    monitorExtractionProgress(jobId);
}

async function monitorExtractionProgress(jobId) {
    try {
        const response = await fetch(`/extraction_progress/${jobId}`);
        const job = await response.json();

        if (job.error) {
            document.getElementById('extractionModal').style.display = 'none';
            showStatus('Error during frame extraction: ' + job.error, 'error');
            return;
        }

        // Update progress bar
        const progressBar = document.getElementById('extractionProgressBarFill');
        progressBar.style.width = job.progress + '%';

        // Update details
        if (job.total_frames) {
            document.getElementById('totalFramesCount').textContent = job.total_frames.toLocaleString();
        }
        if (job.extracted_frames) {
            document.getElementById('extractedFramesCount').textContent = job.extracted_frames.toLocaleString();
        }
        if (job.speed) {
            document.getElementById('extractionSpeed').textContent = job.speed;
        }
        document.getElementById('extractionProgressText').textContent = job.message || 'Processing...';

        // Update step status
        const steps = document.querySelectorAll('.extraction-step');
        steps.forEach(step => step.classList.remove('active', 'completed'));

        if (job.status === 'analyzing') {
            document.getElementById('extractStep1').classList.add('active');
        } else if (job.status === 'extracting') {
            document.getElementById('extractStep1').classList.add('completed');
            document.getElementById('extractStep2').classList.add('active');
        } else if (job.status === 'completing') {
            document.getElementById('extractStep1').classList.add('completed');
            document.getElementById('extractStep2').classList.add('completed');
            document.getElementById('extractStep3').classList.add('active');
        }

        if (job.status === 'completed') {
            // Extraction completed
            steps.forEach(step => step.classList.add('completed'));
            
            // Use the data from the completed job
            totalFrames = job.total;
            const completedData = {
                frames: job.frames_info,
                total: job.total,
                cached: false,
                message: job.message
            };

            // Hide modal after a short delay
            setTimeout(() => {
                document.getElementById('extractionModal').style.display = 'none';
                finishVideoLoad(completedData);
            }, 1000);

        } else if (job.status === 'error') {
            // Error occurred
            document.getElementById('extractionModal').style.display = 'none';
            showStatus('Error during frame extraction: ' + (job.error || 'Unknown error'), 'error');
        } else {
            // Continue polling
            setTimeout(() => monitorExtractionProgress(jobId), 500);
        }

    } catch (error) {
        document.getElementById('extractionModal').style.display = 'none';
        showStatus('Error monitoring extraction progress: ' + error.message, 'error');
    }
}

function formatTime(seconds) {
    const minutes = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    const ms = Math.floor((seconds % 1) * 100);
    return `${minutes}:${secs.toString().padStart(2, '0')}.${ms.toString().padStart(2, '0')}`;
}

function createTimeline() {
    const container = document.getElementById('timelineFrames');
    container.innerHTML = '';

    // Get selected interval or default to 30 seconds
    const intervalSelect = document.getElementById('thumbnailInterval');
    const intervalSeconds = intervalSelect ? parseFloat(intervalSelect.value) : 30;

    // Calculate frame interval based on selected time interval
    const frameInterval = Math.max(1, Math.round(intervalSeconds * videoFPS));

    console.log(`Timeline: ${intervalSeconds}s intervals = every ${frameInterval} frames (FPS: ${videoFPS})`);

    for (let i = 0; i < totalFrames; i += frameInterval) {
        const frameDiv = document.createElement('div');
        frameDiv.className = 'timeline-frame';
        frameDiv.onclick = () => showFrame(i);

        const img = document.createElement('img');
        img.src = `/get_frame/${currentVideo}/${i}`;
        img.alt = `Frame ${i}`;

        // Calculate time for this frame
        const timeInSeconds = i / videoFPS;
        const timeDisplay = document.createElement('div');
        timeDisplay.className = 'time-display';
        timeDisplay.textContent = formatTime(timeInSeconds);

        frameDiv.appendChild(img);
        frameDiv.appendChild(timeDisplay);
        container.appendChild(frameDiv);
    }
}

function updateTimeline() {
    if (totalFrames > 0) {
        createTimeline();
        console.log('Timeline updated with new interval');
    }
}

function showFrame(frameIndex) {
    console.log(`=== SHOWING FRAME ${frameIndex} ===`);
    console.log(`Current rectangles data:`, frameRectangles);

    currentFrameIndex = frameIndex;

    const img = document.getElementById('frameImage');
    const frameUrl = `/get_frame/${currentVideo}/${frameIndex}`;
    console.log(`Loading frame from: ${frameUrl}`);
    img.src = frameUrl;

    // Add error handler for the image
    img.onerror = function () {
        console.error(`Failed to load frame ${frameIndex}`);
        showStatus(`Failed to load frame ${frameIndex + 1}`, 'error');
    };

    img.onload = function () {
        console.log(`Successfully loaded frame ${frameIndex}`);
        // Recalculate image scale when new frame loads
        imageScale = calculateImageScale();
        updateFrameSizeDisplay();
    };

    document.querySelectorAll('.timeline-frame').forEach((frame, index) => {
        const actualIndex = index * Math.max(1, Math.floor(totalFrames / 50));
        frame.classList.toggle('selected', actualIndex === frameIndex);
    });

    const frameInfo = document.getElementById('frameInfo');
    const currentRects = frameRectangles[currentFrameIndex] || [];
    const totalRects = Object.values(frameRectangles).reduce((sum, rects) => sum + rects.length, 0);
    const framesWithChanges = getFramesWithChanges();

    // Calculate current frame time
    const currentTime = formatTime(frameIndex / videoFPS);
    frameInfo.textContent = `Frame ${frameIndex + 1}/${totalFrames} (${currentTime}) | Current: ${currentRects.length} | Total: ${totalRects} | Keyframes: ${framesWithChanges.length}`;

    console.log(`Frame ${frameIndex} has ${currentRects.length} rectangles:`, currentRects);
    console.log(`All frames with keyframes:`, framesWithChanges);

    setupDrawing();
    updateRectangles();
    updateTimelineScrubber();
    console.log(`=== END SHOWING FRAME ${frameIndex} ===`);
}

function updateFrameSizeDisplay() {
    const frameDisplay = document.getElementById('frameDisplay');
    const frameImage = document.getElementById('frameImage');
    const frameSizeInfo = document.getElementById('frameSizeInfo');

    if (!frameSizeInfo) return;

    const containerRect = frameDisplay.getBoundingClientRect();
    const containerWidth = Math.round(containerRect.width);
    const containerHeight = Math.round(containerRect.height);

    if (frameImage.naturalWidth && frameImage.naturalHeight) {
        const scale = calculateImageScale();
        const displayedWidth = Math.round(scale.displayedWidth);
        const displayedHeight = Math.round(scale.displayedHeight);

        frameSizeInfo.textContent = `Container: ${containerWidth}×${containerHeight} | Image: ${displayedWidth}×${displayedHeight} | Original: ${frameImage.naturalWidth}×${frameImage.naturalHeight}`;
    } else {
        frameSizeInfo.textContent = `Container: ${containerWidth}×${containerHeight}`;
    }
}

function calculateImageScale() {
    const frameDisplay = document.getElementById('frameDisplay');
    const frameImage = document.getElementById('frameImage');

    if (!frameImage.naturalWidth || !frameImage.naturalHeight) {
        return { x: 1, y: 1, offsetX: 0, offsetY: 0 };
    }

    const containerRect = frameDisplay.getBoundingClientRect();
    const imageAspect = frameImage.naturalWidth / frameImage.naturalHeight;
    const containerAspect = containerRect.width / containerRect.height;

    let displayedWidth, displayedHeight, offsetX, offsetY;

    if (imageAspect > containerAspect) {
        // Image is wider, limited by container width
        displayedWidth = containerRect.width;
        displayedHeight = containerRect.width / imageAspect;
        offsetX = 0;
        offsetY = (containerRect.height - displayedHeight) / 2;
    } else {
        // Image is taller, limited by container height  
        displayedWidth = containerRect.height * imageAspect;
        displayedHeight = containerRect.height;
        offsetX = (containerRect.width - displayedWidth) / 2;
        offsetY = 0;
    }

    return {
        x: frameImage.naturalWidth / displayedWidth,
        y: frameImage.naturalHeight / displayedHeight,
        offsetX: offsetX,
        offsetY: offsetY,
        displayedWidth: displayedWidth,
        displayedHeight: displayedHeight
    };
}

function setupDrawing() {
    const frameDisplay = document.getElementById('frameDisplay');

    // Set up ResizeObserver to monitor frame container size changes
    if (window.ResizeObserver) {
        const resizeObserver = new ResizeObserver((entries) => {
            for (let entry of entries) {
                // Update image scale and size display when container is resized
                imageScale = calculateImageScale();
                updateFrameSizeDisplay();
                updateRectangles(); // Reposition rectangles with new scale
            }
        });
        resizeObserver.observe(frameDisplay);
    }

    frameDisplay.onmousedown = function (e) {
        if (e.target !== document.getElementById('frameImage')) return;
        
        // Prevent default image drag behavior
        e.preventDefault();

        // Update image scale calculation
        imageScale = calculateImageScale();

        // Clear selection when clicking on empty area
        selectedRect = null;
        document.querySelectorAll('.rectangle').forEach(r => {
            r.classList.remove('selected');
            r.querySelectorAll('.resize-handle').forEach(h => h.remove());
        });
        
        // Disable track button when no selection
        const trackBtn = document.getElementById('trackBtn');
        if (trackBtn) {
            trackBtn.disabled = true;
        }
        
        // Update property table to show no selection
        updatePropertyTable();

        isDrawing = true;
        const rect = frameDisplay.getBoundingClientRect();

        // Adjust coordinates to account for image offset and ensure they're within image bounds
        const rawX = e.clientX - rect.left;
        const rawY = e.clientY - rect.top;

        // Only allow drawing within the actual image area
        if (rawX < imageScale.offsetX || rawX > imageScale.offsetX + imageScale.displayedWidth ||
            rawY < imageScale.offsetY || rawY > imageScale.offsetY + imageScale.displayedHeight) {
            isDrawing = false;
            return;
        }

        startX = rawX;
        startY = rawY;

        currentRect = document.createElement('div');
        currentRect.className = 'rectangle';
        currentRect.style.left = startX + 'px';
        currentRect.style.top = startY + 'px';
        frameDisplay.appendChild(currentRect);
    };

    frameDisplay.onmousemove = function (e) {
        const rect = frameDisplay.getBoundingClientRect();
        let currentX = e.clientX - rect.left;
        let currentY = e.clientY - rect.top;

        if (isDrawing && currentRect) {
            // Constrain drawing to image bounds
            currentX = Math.max(imageScale.offsetX, Math.min(currentX, imageScale.offsetX + imageScale.displayedWidth));
            currentY = Math.max(imageScale.offsetY, Math.min(currentY, imageScale.offsetY + imageScale.displayedHeight));

            const width = Math.abs(currentX - startX);
            const height = Math.abs(currentY - startY);
            const left = Math.min(startX, currentX);
            const top = Math.min(startY, currentY);

            currentRect.style.left = left + 'px';
            currentRect.style.top = top + 'px';
            currentRect.style.width = width + 'px';
            currentRect.style.height = height + 'px';
        } else if (isDragging && selectedRect) {
            let newX = currentX - dragOffset.x;
            let newY = currentY - dragOffset.y;

            // Constrain dragging to image bounds
            const rectWidth = parseInt(selectedRect.element.style.width);
            const rectHeight = parseInt(selectedRect.element.style.height);

            newX = Math.max(imageScale.offsetX, Math.min(newX, imageScale.offsetX + imageScale.displayedWidth - rectWidth));
            newY = Math.max(imageScale.offsetY, Math.min(newY, imageScale.offsetY + imageScale.displayedHeight - rectHeight));

            selectedRect.element.style.left = newX + 'px';
            selectedRect.element.style.top = newY + 'px';
        } else if (isResizing && selectedRect) {
            handleResize(currentX, currentY);
        }
    };

    frameDisplay.onmouseup = function (e) {
        if (isDrawing && currentRect) {
            isDrawing = false;

            const rectStyle = currentRect.style;
            const x = parseInt(rectStyle.left);
            const y = parseInt(rectStyle.top);
            const width = parseInt(rectStyle.width);
            const height = parseInt(rectStyle.height);

            if (width > 10 && height > 10) {
                if (!frameRectangles[currentFrameIndex]) {
                    frameRectangles[currentFrameIndex] = [];
                }

                // Convert display coordinates to image coordinates for storage
                const imageX = (x - imageScale.offsetX) * imageScale.x;
                const imageY = (y - imageScale.offsetY) * imageScale.y;
                const imageWidth = width * imageScale.x;
                const imageHeight = height * imageScale.y;

                // Generate a proper rectangleId for the new rectangle
                const rectIndex = frameRectangles[currentFrameIndex].length;
                const rectangleId = `${currentFrameIndex}_${rectIndex}`;

                const newRect = {
                    x: Math.round(imageX),
                    y: Math.round(imageY),
                    width: Math.round(imageWidth),
                    height: Math.round(imageHeight),
                    rectangleId: rectangleId
                };
                frameRectangles[currentFrameIndex].push(newRect);
                console.log(`Added rectangle to frame ${currentFrameIndex}:`, newRect);
                console.log(`Frame ${currentFrameIndex} now has ${frameRectangles[currentFrameIndex].length} rectangles`);
                updateFrameInfo();

                // Auto-save after adding new rectangle
                autoSaveRectangles();
            }

            currentRect = null;
            updateRectangles();
        } else if (isDragging && selectedRect) {
            console.log('Rectangle drag completed, updating data...');
            console.log('Selected rectangle:', selectedRect.rect);

            // Update rectangle data
            const rectStyle = selectedRect.element.style;
            const displayX = parseInt(rectStyle.left);
            const displayY = parseInt(rectStyle.top);
            const displayWidth = parseInt(rectStyle.width);
            const displayHeight = parseInt(rectStyle.height);

            // Convert display coordinates to image coordinates for storage
            const imageX = (displayX - imageScale.offsetX) * imageScale.x;
            const imageY = (displayY - imageScale.offsetY) * imageScale.y;
            const imageWidth = displayWidth * imageScale.x;
            const imageHeight = displayHeight * imageScale.y;

            const rectData = {
                x: Math.round(imageX),
                y: Math.round(imageY),
                width: Math.round(imageWidth),
                height: Math.round(imageHeight)
            };

            console.log('Rectangle data to save:', rectData);

            if (selectedRect.rect && !selectedRect.rect.isFromCurrentFrame) {
                // If adjusting an inherited rectangle, we need to track this as a move event
                // But don't create duplicate entries - the getAllRectanglesForFrame handles this
                const originalRectId = selectedRect.rect.rectId;

                console.log('Moving inherited rectangle:', { originalRectId, newPosition: rectData });

                // Ensure the current frame has a rectangles array
                if (!frameRectangles[currentFrameIndex]) {
                    frameRectangles[currentFrameIndex] = [];
                }

                // Create a rectangleMoved event entry
                const movedRect = {
                    rectangleMoved: originalRectId, // Reference to the original rectangle
                    x: rectData.x,
                    y: rectData.y,
                    width: rectData.width,
                    height: rectData.height
                };

                // Check for existing move event for this rectangleId
                const existingMoveIndex = frameRectangles[currentFrameIndex].findIndex(r => r.rectangleMoved === originalRectId);
                
                if (existingMoveIndex >= 0) {
                    // Update existing move event
                    frameRectangles[currentFrameIndex][existingMoveIndex] = movedRect;
                    console.log('Updated existing rectangleMoved event:', movedRect);
                } else {
                    // Create new move event
                    frameRectangles[currentFrameIndex].push(movedRect);
                    console.log('Created new rectangleMoved event:', movedRect);
                }
                showStatus(`Rectangle moved from frame ${parseInt(originalRectId.split('_')[0]) + 1} to frame ${currentFrameIndex + 1}`, 'success');
            } else {
                // Update rectangle that was created on current frame
                const allCurrentRects = frameRectangles[currentFrameIndex] || [];
                const currentRects = getCurrentFrameRectangles();

                console.log('Updating current frame rectangle:');
                console.log('Selected rect index:', selectedRect.index);
                console.log('All current rects (including removal markers):', allCurrentRects);
                console.log('Filtered current rects (no removal markers):', currentRects);

                // Find the actual index in the full array (including removal markers)
                let actualIndex = -1;

                // If the selected rectangle has a rectId, use it to find the original rectangle
                if (selectedRect.rect && selectedRect.rect.rectId) {
                    const rectIdParts = selectedRect.rect.rectId.split('_');
                    const originalFrame = parseInt(rectIdParts[0]);
                    const originalIndex = parseInt(rectIdParts[1]);

                    if (originalFrame === currentFrameIndex) {
                        // This rectangle was created on the current frame
                        actualIndex = originalIndex;
                    }
                }

                // If we couldn't find the index using rectId, try to match by coordinates
                if (actualIndex === -1 && currentRects.length !== allCurrentRects.length) {
                    // There are removal markers, so we need to find the correct index
                    if (selectedRect.index < currentRects.length) {
                        const targetRect = currentRects[selectedRect.index];
                        actualIndex = allCurrentRects.findIndex(rect =>
                            !rect.isRemovalMarker &&
                            rect.x === targetRect.x &&
                            rect.y === targetRect.y &&
                            rect.width === targetRect.width &&
                            rect.height === targetRect.height
                        );
                    }
                }

                // If still not found, try using the selected index directly
                if (actualIndex === -1 && selectedRect.index < allCurrentRects.length && !allCurrentRects[selectedRect.index].isRemovalMarker) {
                    actualIndex = selectedRect.index;
                }

                console.log('Calculated actual index:', actualIndex);

                if (actualIndex !== -1 && allCurrentRects && allCurrentRects[actualIndex]) {
                    const oldData = { ...allCurrentRects[actualIndex] };
                    Object.assign(allCurrentRects[actualIndex], rectData);
                    console.log('Updated rectangle from', oldData, 'to', allCurrentRects[actualIndex]);
                } else {
                    console.error('Could not find current rectangle to update:', actualIndex);
                    console.error('Available rectangle indices:', Object.keys(allCurrentRects || {}));
                    console.error('Selected rectangle data:', selectedRect);
                }
            }
            isDragging = false;

            // Update property table with new coordinates
            updatePropertyTable();

            // Update timeline keyframes
            updateTimelineKeyframes();

            // Auto-save after rectangle modification
            console.log('Rectangle moved, triggering auto-save...');
            autoSaveRectangles();
        } else if (isResizing && selectedRect) {
            // Update rectangle data
            const rectStyle = selectedRect.element.style;
            const displayX = parseInt(rectStyle.left);
            const displayY = parseInt(rectStyle.top);
            const displayWidth = parseInt(rectStyle.width);
            const displayHeight = parseInt(rectStyle.height);

            // Convert display coordinates to image coordinates for storage
            const imageX = (displayX - imageScale.offsetX) * imageScale.x;
            const imageY = (displayY - imageScale.offsetY) * imageScale.y;
            const imageWidth = displayWidth * imageScale.x;
            const imageHeight = displayHeight * imageScale.y;

            const rectData = {
                x: Math.round(imageX),
                y: Math.round(imageY),
                width: Math.round(imageWidth),
                height: Math.round(imageHeight)
            };

            if (selectedRect.rect && !selectedRect.rect.isFromCurrentFrame) {
                // If resizing an inherited rectangle, create a rectangleResized event
                const originalRectId = selectedRect.rect.rectId;

                console.log('Creating rectangleResized entry for inherited rectangle:', { originalRectId });

                // Ensure the current frame has a rectangles array
                if (!frameRectangles[currentFrameIndex]) {
                    frameRectangles[currentFrameIndex] = [];
                }

                // Create a new rectangle entry with the rectangleResized property
                const resizedRect = {
                    ...rectData,
                    rectangleResized: originalRectId // Reference to the original rectangle
                };

                // Check for existing resize event for this rectangleId
                const existingResizeIndex = frameRectangles[currentFrameIndex].findIndex(r => r.rectangleResized === originalRectId);
                
                if (existingResizeIndex >= 0) {
                    // Update existing resize event
                    frameRectangles[currentFrameIndex][existingResizeIndex] = resizedRect;
                    console.log('Updated existing rectangleResized event:', resizedRect);
                } else {
                    // Create new resize event
                    frameRectangles[currentFrameIndex].push(resizedRect);
                    console.log('Created new rectangleResized event:', resizedRect);
                }
                showStatus(`Rectangle resized from frame ${parseInt(originalRectId.split('_')[0]) + 1}`, 'success');
            } else {
                // Update rectangle that was created on current frame
                const allCurrentRects = frameRectangles[currentFrameIndex] || [];
                const currentRects = getCurrentFrameRectangles();

                // Find the actual index in the full array (including removal markers)
                let actualIndex = -1;

                // If the selected rectangle has a rectId, use it to find the original rectangle
                if (selectedRect.rect && selectedRect.rect.rectId) {
                    const rectIdParts = selectedRect.rect.rectId.split('_');
                    const originalFrame = parseInt(rectIdParts[0]);
                    const originalIndex = parseInt(rectIdParts[1]);

                    if (originalFrame === currentFrameIndex) {
                        // This rectangle was created on the current frame
                        actualIndex = originalIndex;
                    }
                }

                // If we couldn't find the index using rectId, try to match by coordinates
                if (actualIndex === -1 && currentRects.length !== allCurrentRects.length) {
                    // There are removal markers, so we need to find the correct index
                    if (selectedRect.index < currentRects.length) {
                        const targetRect = currentRects[selectedRect.index];
                        actualIndex = allCurrentRects.findIndex(rect =>
                            !rect.isRemovalMarker &&
                            rect.x === targetRect.x &&
                            rect.y === targetRect.y &&
                            rect.width === targetRect.width &&
                            rect.height === targetRect.height
                        );
                    }
                }

                // If still not found, try using the selected index directly
                if (actualIndex === -1 && selectedRect.index < allCurrentRects.length && !allCurrentRects[selectedRect.index].isRemovalMarker) {
                    actualIndex = selectedRect.index;
                }

                if (actualIndex !== -1 && allCurrentRects && allCurrentRects[actualIndex]) {
                    Object.assign(allCurrentRects[actualIndex], rectData);
                } else {
                    console.error('Could not find current rectangle to update during resize:', actualIndex);
                    console.error('Available rectangle indices:', Object.keys(allCurrentRects || {}));
                    console.error('Selected rectangle data:', selectedRect);
                }
            }
            isResizing = false;
            resizeHandle = null;

            // Update property table with new dimensions
            updatePropertyTable();

            // Update timeline keyframes
            updateTimelineKeyframes();

            // Auto-save after rectangle modification
            autoSaveRectangles();
        }
    };
}

function handleResize(currentX, currentY) {
    const rect = selectedRect.element;
    const rectData = frameRectangles[currentFrameIndex][selectedRect.index];
    
    // Convert current mouse position to image coordinates
    const imageX = (currentX - imageScale.offsetX) * imageScale.x;
    const imageY = (currentY - imageScale.offsetY) * imageScale.y;
    
    let newX = rectData.x;
    let newY = rectData.y;
    let newWidth = rectData.width;
    let newHeight = rectData.height;

    switch (resizeHandle) {
        case 'nw':
            newWidth = rectData.x + rectData.width - imageX;
            newHeight = rectData.y + rectData.height - imageY;
            newX = imageX;
            newY = imageY;
            break;
        case 'ne':
            newWidth = imageX - rectData.x;
            newHeight = rectData.y + rectData.height - imageY;
            newY = imageY;
            // Preserve X position
            newX = rectData.x;
            break;
        case 'sw':
            newWidth = rectData.x + rectData.width - imageX;
            newHeight = imageY - rectData.y;
            newX = imageX;
            // Preserve Y position
            newY = rectData.y;
            break;
        case 'se':
            newWidth = imageX - rectData.x;
            newHeight = imageY - rectData.y;
            // Preserve X and Y position
            newX = rectData.x;
            newY = rectData.y;
            break;
        case 'n':
            newHeight = rectData.y + rectData.height - imageY;
            newY = imageY;
            // Preserve X and width
            newX = rectData.x;
            newWidth = rectData.width;
            break;
        case 's':
            newHeight = imageY - rectData.y;
            // Preserve X, Y and width
            newX = rectData.x;
            newY = rectData.y;
            newWidth = rectData.width;
            break;
        case 'w':
            newWidth = rectData.x + rectData.width - imageX;
            newX = imageX;
            // Preserve Y and height
            newY = rectData.y;
            newHeight = rectData.height;
            break;
        case 'e':
            newWidth = imageX - rectData.x;
            // Preserve X, Y and height
            newX = rectData.x;
            newY = rectData.y;
            newHeight = rectData.height;
            break;
    }

    // Ensure minimum size (in image coordinates)
    const minSizeImage = 20 * imageScale.x; // Convert 20px display to image coordinates
    if (newWidth < minSizeImage) newWidth = minSizeImage;
    if (newHeight < minSizeImage) newHeight = minSizeImage;

    // Convert back to display coordinates for setting styles
    const displayX = (newX / imageScale.x) + imageScale.offsetX;
    const displayY = (newY / imageScale.y) + imageScale.offsetY;
    const displayWidth = newWidth / imageScale.x;
    const displayHeight = newHeight / imageScale.y;

    rect.style.left = displayX + 'px';
    rect.style.top = displayY + 'px';
    rect.style.width = displayWidth + 'px';
    rect.style.height = displayHeight + 'px';
}

function getActiveRectanglesForFrame(frameIndex) {
    // Get all rectangles that should be active on this frame
    const activeRects = [];

    // Look through all frames from 0 to current frame
    for (let i = 0; i <= frameIndex; i++) {
        if (frameRectangles[i]) {
            frameRectangles[i].forEach((rect, rectIndex) => {
                const rectId = `${i}_${rectIndex}`;

                // Check if this rectangle was removed in a later frame
                let isRemoved = false;
                for (let j = i + 1; j <= frameIndex; j++) {
                    if (frameRectangles[j]) {
                        // Check if any rectangle in frame j is marked as removing this one
                        const removedRect = frameRectangles[j].find(r => r.removesRect === rectId);
                        if (removedRect) {
                            isRemoved = true;
                            break;
                        }
                    }
                }

                if (!isRemoved) {
                    activeRects.push({
                        ...rect,
                        originalFrame: i,
                        rectId: rectId,
                        isFromCurrentFrame: i === frameIndex
                    });
                }
            });
        }
    }

    return activeRects;
}

function getAllRectanglesForFrame(frameIndex) {
    // Get all rectangles including deleted ones for display purposes
    const allRects = [];
    const rectangleStates = {}; // Track current state of each rectangle

    console.log(`\n=== GET ALL RECTANGLES FOR FRAME(${frameIndex}) ===`);
    console.log('Current frameRectangles:', frameRectangles);

    // First pass: Build rectangle states by processing all events chronologically
    for (let i = 0; i <= frameIndex; i++) {
        if (frameRectangles[i]) {
            console.log(`Processing frame ${i} with ${frameRectangles[i].length} items`);
            frameRectangles[i].forEach((rect, rectIndex) => {
                if (rect.isRemovalMarker) {
                    // Handle deletion
                    const deletedRectId = rect.removesRect;
                    console.log(`  Found removal marker for ${deletedRectId} in frame ${i}:`, rect);
                    if (rectangleStates[deletedRectId]) {
                        rectangleStates[deletedRectId].isDeleted = true;
                        rectangleStates[deletedRectId].removalFrame = i;
                        console.log(`  Marked rectangle ${deletedRectId} as deleted in frame ${i}`);
                    } else {
                        console.log(`  WARNING: Cannot find rectangle ${deletedRectId} to mark as deleted`);
                    }
                } else if (rect.rectangleMoved) {
                    // Handle move - update the original rectangle's position
                    const originalRectId = rect.rectangleMoved;
                    if (rectangleStates[originalRectId]) {
                        rectangleStates[originalRectId].x = rect.x;
                        rectangleStates[originalRectId].y = rect.y;
                        rectangleStates[originalRectId].width = rect.width;
                        rectangleStates[originalRectId].height = rect.height;
                        rectangleStates[originalRectId].lastMoveFrame = i;
                        console.log(`  Updated rectangle ${originalRectId} position in frame ${i}:`, rect);
                    }
                } else if (rect.rectangleResized) {
                    // Handle resize - update the original rectangle's dimensions
                    const originalRectId = rect.rectangleResized;
                    if (rectangleStates[originalRectId]) {
                        rectangleStates[originalRectId].x = rect.x;
                        rectangleStates[originalRectId].y = rect.y;
                        rectangleStates[originalRectId].width = rect.width;
                        rectangleStates[originalRectId].height = rect.height;
                        rectangleStates[originalRectId].lastResizeFrame = i;
                        console.log(`  Updated rectangle ${originalRectId} size in frame ${i}:`, rect);
                    }
                } else if (rect.hasOwnProperty('x') && rect.hasOwnProperty('y')) {
                    // Handle creation - add new rectangle
                    // Use the rectangleId from the rectangle data, or generate one if missing
                    const rectId = rect.rectangleId || `${i}_${rectIndex}`;
                    rectangleStates[rectId] = {
                        ...rect,
                        originalFrame: i,
                        rectId: rectId,
                        isFromCurrentFrame: i === frameIndex,
                        isDeleted: false,
                        removalFrame: null,
                        lastMoveFrame: null,
                        lastResizeFrame: null
                    };
                    console.log(`  Created rectangle ${rectId} in frame ${i}:`, rect);
                }
            });
        }
    }

    // Second pass: Add active rectangles to display list
    console.log(`Final rectangleStates for frame ${frameIndex}:`, Object.keys(rectangleStates));
    for (const [rectId, rectState] of Object.entries(rectangleStates)) {
        if (!rectState.isDeleted || rectState.removalFrame === frameIndex) {
            // Show rectangle if it's not deleted, or if it was deleted on current frame (to show ghost)
            allRects.push({
                ...rectState,
                isMoved: rectState.lastMoveFrame !== null,
                isResized: rectState.lastResizeFrame !== null
            });
            console.log(`  Added rectangle ${rectId} to display list - pos:(${rectState.x},${rectState.y})`);
        } else {
            console.log(`  Skipped deleted rectangle ${rectId} (deleted in frame ${rectState.removalFrame})`);
        }
    }

    console.log(`=== RETURNING ${allRects.length} RECTANGLES ===\n`);
    return allRects;
}

function updateRectangles() {
    console.log(`=== UPDATE RECTANGLES FOR FRAME ${currentFrameIndex} ===`);
    const frameDisplay = document.getElementById('frameDisplay');
    const existingRects = frameDisplay.querySelectorAll('.rectangle');
    console.log(`Removing ${existingRects.length} existing rectangle elements`);
    existingRects.forEach(rect => rect.remove());

    // Update image scale for current display
    imageScale = calculateImageScale();
    updateFrameSizeDisplay();

    // Get all rectangles including deleted ones for current frame
    const allRects = getAllRectanglesForFrame(currentFrameIndex);
    console.log(`Drawing ${allRects.length} rectangles for frame ${currentFrameIndex}:`, allRects);

    allRects.forEach((rect, index) => {
        console.log(`Drawing rectangle ${index}:`, rect);
        const rectDiv = document.createElement('div');

        // Style based on rectangle state
        if (rect.isDeleted && rect.removalFrame === currentFrameIndex) {
            // Show deleted rectangle as ghost ONLY on the frame where it was deleted
            rectDiv.className = 'rectangle deleted-rectangle';
        } else if (rect.isDeleted && rect.removalFrame < currentFrameIndex) {
            // For frames after deletion, don't show the deleted rectangle at all
            return; // Skip this rectangle entirely
        } else if (rect.isMoved) {
            // Show moved rectangle with a special style
            rectDiv.className = 'rectangle moved-rectangle';
        } else if (rect.isResized) {
            // Show resized rectangle with a special style
            rectDiv.className = 'rectangle resized-rectangle';
        } else if (rect.isFromCurrentFrame) {
            rectDiv.className = 'rectangle';
        } else {
            rectDiv.className = 'rectangle inherited-rectangle';
        }

        // Convert image coordinates to display coordinates
        const displayX = (rect.x / imageScale.x) + imageScale.offsetX;
        const displayY = (rect.y / imageScale.y) + imageScale.offsetY;
        const displayWidth = rect.width / imageScale.x;
        const displayHeight = rect.height / imageScale.y;

        rectDiv.style.left = Math.round(displayX) + 'px';
        rectDiv.style.top = Math.round(displayY) + 'px';
        rectDiv.style.width = Math.round(displayWidth) + 'px';
        rectDiv.style.height = Math.round(displayHeight) + 'px';
        rectDiv.dataset.index = index;
        rectDiv.dataset.rectId = rect.rectId;
        rectDiv.dataset.originalFrame = rect.originalFrame;

        // Add click handler for selection/deletion (only for non-deleted rectangles)
        if (!rect.isDeleted) {
            rectDiv.onclick = (e) => {
                e.stopPropagation();
                if (e.shiftKey) {
                    // Shift+click to remove - this marks rectangle as removed from this frame forward
                    removeRectangleFromCurrentFrame(rect.rectId);
                } else {
                    // Regular click to select
                    selectRectangle(rectDiv, index, rect);
                }
            };

            // Add drag functionality
            rectDiv.onmousedown = (e) => {
                if (e.target === rectDiv) {
                    startDragging(e, rectDiv, index, rect);
                }
            };
        }

        // Add delete/undelete button
        const actionBtn = document.createElement('div');

        if (rect.isDeleted) {
            // Show undelete button for deleted rectangles
            actionBtn.className = 'rectangle-undelete';
            actionBtn.textContent = '↺';
            actionBtn.title = 'Restore rectangle';
            actionBtn.onclick = (e) => {
                e.stopPropagation();
                handleRectangleUndelete(rect, index);
            };
        } else {
            // Show delete button for active rectangles
            actionBtn.className = rect.isFromCurrentFrame ? 'rectangle-delete' : 'rectangle-delete inherited';
            actionBtn.textContent = '×';
            actionBtn.title = rect.isFromCurrentFrame ? 'Delete rectangle' : 'Remove from this frame forward';
            actionBtn.onclick = (e) => {
                e.stopPropagation();
                handleRectangleDelete(rect, index);
            };
        }

        // Add rectangle ID label in top left corner
        const idLabel = document.createElement('div');
        idLabel.className = 'rectangle-id-label';
        idLabel.textContent = rect.rectId || `rect_${index}`;
        idLabel.title = `Rectangle ID: ${rect.rectId || `rect_${index}`}`;
        rectDiv.appendChild(idLabel);

        rectDiv.appendChild(actionBtn);
        frameDisplay.appendChild(rectDiv);

        // If this is a deleted rectangle, make it non-interactive but keep the undelete button functional
        if (rect.isDeleted) {
            rectDiv.style.pointerEvents = 'none';
            // Find the undelete button and make it clickable
            const undeleteBtn = rectDiv.querySelector('.rectangle-undelete');
            if (undeleteBtn) {
                undeleteBtn.style.pointerEvents = 'auto';
            }
        }
    });
    
    // Clear property table since no rectangle is selected after frame update
    updatePropertyTable();
    console.log(`=== END UPDATE RECTANGLES FOR FRAME ${currentFrameIndex} ===`);
}

function updatePropertyTable() {
    const tableBody = document.getElementById('propertyTableBody');
    tableBody.innerHTML = '';

    // Check if there's a selected rectangle
    if (!selectedRect || !selectedRect.rect) {
        const row = document.createElement('tr');
        row.className = 'no-selection';
        row.innerHTML = '<td colspan="2">No rectangle selected</td>';
        tableBody.appendChild(row);
        return;
    }

    const rect = selectedRect.rect;
    const index = selectedRect.index;
    
    // Get effect type based on blur amount selection
    const blurSelect = document.getElementById('blurAmount');
    const blurValue = blurSelect ? blurSelect.value : '15';
    let effectType = 'Gaussian Blur';
    if (blurValue <= 5) effectType = 'Light Blur';
    else if (blurValue <= 10) effectType = 'Medium Blur';
    else if (blurValue <= 15) effectType = 'Heavy Blur';
    else if (blurValue <= 20) effectType = 'Very Heavy Blur';
    else effectType = 'Extreme Blur';

    // Create property rows
    const properties = [
        { label: 'Rectangle ID', value: rect.rectId || `rect_${index}` },
        { label: 'X Position', value: `${Math.round(rect.x)}px` },
        { label: 'Y Position', value: `${Math.round(rect.y)}px` },
        { label: 'Width', value: `${Math.round(rect.width)}px` },
        { label: 'Height', value: `${Math.round(rect.height)}px` },
        { label: 'Effect Type', value: effectType },
        { label: 'Blur Intensity', value: `${blurValue}px` }
    ];

    properties.forEach(prop => {
        const row = document.createElement('tr');
        row.innerHTML = `
            <td class="property-label">${prop.label}</td>
            <td class="property-value">${prop.value}</td>
        `;
        tableBody.appendChild(row);
    });
}

// Timeline Scrubber Functions
function initializeTimelineScrubber() {
    console.log('Initializing timeline scrubber...');
    const track = document.getElementById('timelineTrack');
    const handle = document.getElementById('timelineHandle');
    const progress = document.getElementById('timelineProgress');
    
    console.log('Timeline elements:', { track, handle, progress, totalFrames });
    
    if (!track || !handle || !progress) {
        console.error('Timeline elements not found:', { track, handle, progress });
        return;
    }
    
    if (totalFrames === 0) {
        console.error('Total frames is 0, cannot initialize timeline');
        return;
    }

    let timelineDragging = false;

    // Click on track to jump to position
    track.addEventListener('click', (e) => {
        if (e.target === handle) return; // Don't trigger on handle clicks
        if (e.target.classList.contains('timeline-keyframe')) return; // Don't trigger on keyframe clicks
        
        const rect = track.getBoundingClientRect();
        const clickX = e.clientX - rect.left;
        const percentage = clickX / rect.width;
        const targetFrame = Math.round(percentage * (totalFrames - 1));
        
        console.log('Timeline clicked:', { clickX, percentage, targetFrame });
        showFrame(Math.max(0, Math.min(totalFrames - 1, targetFrame)));
    });

    // Handle dragging
    handle.addEventListener('mousedown', (e) => {
        timelineDragging = true;
        e.preventDefault();
        console.log('Timeline drag started');
    });

    document.addEventListener('mousemove', (e) => {
        if (!timelineDragging) return;
        
        const rect = track.getBoundingClientRect();
        const mouseX = e.clientX - rect.left;
        const percentage = Math.max(0, Math.min(1, mouseX / rect.width));
        const targetFrame = Math.round(percentage * (totalFrames - 1));
        
        console.log('Timeline dragging:', { mouseX, percentage, targetFrame });
        showFrame(Math.max(0, Math.min(totalFrames - 1, targetFrame)));
    });

    document.addEventListener('mouseup', () => {
        if (timelineDragging) {
            console.log('Timeline drag ended');
        }
        timelineDragging = false;
    });

    // Update timeline when frames change
    updateTimelineScrubber();
    
    console.log('Timeline scrubber initialization completed successfully');
}

function updateTimelineScrubber() {
    const handle = document.getElementById('timelineHandle');
    const progress = document.getElementById('timelineProgress');
    const keyframesContainer = document.getElementById('timelineKeyframes');
    
    if (!handle || !progress || !keyframesContainer || totalFrames === 0) {
        console.log('updateTimelineScrubber: Missing elements or totalFrames=0', { 
            handle, progress, keyframesContainer, totalFrames 
        });
        return;
    }

    // Update handle and progress position
    const percentage = (currentFrameIndex / (totalFrames - 1)) * 100;
    handle.style.left = percentage + '%';
    progress.style.width = percentage + '%';
    
    console.log('Timeline scrubber updated:', { currentFrameIndex, totalFrames, percentage });

    // Update keyframes
    updateTimelineKeyframes();
}

function updateTimelineKeyframes() {
    const keyframesContainer = document.getElementById('timelineKeyframes');
    if (!keyframesContainer || totalFrames === 0) return;

    // Clear existing keyframes
    keyframesContainer.innerHTML = '';

    // Get frames with keyframes
    const framesWithKeyframes = getFramesWithChanges();
    
    framesWithKeyframes.forEach(frameIndex => {
        const keyframe = document.createElement('div');
        keyframe.className = 'timeline-keyframe';
        if (frameIndex === currentFrameIndex) {
            keyframe.classList.add('active');
        }
        
        const percentage = (frameIndex / (totalFrames - 1)) * 100;
        keyframe.style.left = percentage + '%';
        keyframe.title = `Keyframe at frame ${frameIndex + 1}`;
        
        // Add click handler to jump to keyframe
        keyframe.addEventListener('click', (e) => {
            e.stopPropagation();
            showFrame(frameIndex);
        });
        
        keyframesContainer.appendChild(keyframe);
    });
}

function handleRectangleDelete(rect, index) {
    // Check if this rectangle has a move or resize event in the current frame
    const currentFrameRects = frameRectangles[currentFrameIndex] || [];
    const moveEventIndex = currentFrameRects.findIndex(r => r.rectangleMoved === rect.rectId);
    const resizeEventIndex = currentFrameRects.findIndex(r => r.rectangleResized === rect.rectId);
    
    if (moveEventIndex >= 0) {
        // Rectangle was moved in current frame - remove the move event
        currentFrameRects.splice(moveEventIndex, 1);
        if (currentFrameRects.length === 0) {
            delete frameRectangles[currentFrameIndex];
        }
        showToast(`Move event removed from frame ${currentFrameIndex + 1}`, 'success', 2000);
        updateRectangles();
        updateTimelineScrubber();
        autoSaveRectangles();
        return;
    }
    
    if (resizeEventIndex >= 0) {
        // Rectangle was resized in current frame - remove the resize event
        currentFrameRects.splice(resizeEventIndex, 1);
        if (currentFrameRects.length === 0) {
            delete frameRectangles[currentFrameIndex];
        }
        showToast(`Resize event removed from frame ${currentFrameIndex + 1}`, 'success', 2000);
        updateRectangles();
        updateTimelineScrubber();
        autoSaveRectangles();
        return;
    }
    
    if (rect.isFromCurrentFrame) {
        // Rectangle was created on current frame - delete it entirely
        const allCurrentRects = frameRectangles[currentFrameIndex] || [];
        const currentRects = getCurrentFrameRectangles();

        // Find the actual index in the full array (including removal markers)
        let actualIndex = -1;

        // If the selected rectangle has a rectId, use it to find the original rectangle
        if (rect && rect.rectId) {
            const rectIdParts = rect.rectId.split('_');
            const originalFrame = parseInt(rectIdParts[0]);
            const originalIndex = parseInt(rectIdParts[1]);

            if (originalFrame === currentFrameIndex) {
                // This rectangle was created on the current frame
                actualIndex = originalIndex;
            }
        }

        // If we couldn't find the index using rectId, try to match by coordinates
        if (actualIndex === -1 && currentRects.length !== allCurrentRects.length) {
            // There are removal markers, so we need to find the correct index
            if (index < currentRects.length) {
                const targetRect = currentRects[index];
                actualIndex = allCurrentRects.findIndex(r =>
                    !r.isRemovalMarker &&
                    r.x === targetRect.x &&
                    r.y === targetRect.y &&
                    r.width === targetRect.width &&
                    r.height === targetRect.height
                );
            }
        }

        // If still not found, try using the selected index directly
        if (actualIndex === -1 && index < allCurrentRects.length && !allCurrentRects[index].isRemovalMarker) {
            actualIndex = index;
        }

        if (actualIndex !== -1 && allCurrentRects && allCurrentRects[actualIndex]) {
            allCurrentRects.splice(actualIndex, 1);
            if (allCurrentRects.length === 0) {
                delete frameRectangles[currentFrameIndex];
            }
            showToast(`Rectangle deleted from frame ${currentFrameIndex + 1}`, 'success', 2000);
        }
    } else {
        // Rectangle is inherited - mark for removal but keep as ghost
        removeRectangleFromCurrentFrame(rect.rectId);
        showToast(`Rectangle marked for removal from frame ${currentFrameIndex + 1} forward`, 'warning', 3000);
    }

    updateFrameInfo();
    updateRectangles();
    
    // Update timeline scrubber and keyframes to reflect changes
    updateTimelineScrubber();

    // Auto-save after rectangle deletion
    autoSaveRectangles();
}

function handleRectangleUndelete(rect, index) {
    // Remove the removal marker for this rectangle
    if (frameRectangles[currentFrameIndex]) {
        const removalMarkerIndex = frameRectangles[currentFrameIndex].findIndex(r =>
            r.removesRect === rect.rectId && r.isRemovalMarker
        );

        if (removalMarkerIndex !== -1) {
            frameRectangles[currentFrameIndex].splice(removalMarkerIndex, 1);
            if (frameRectangles[currentFrameIndex].length === 0) {
                delete frameRectangles[currentFrameIndex];
            }
            showToast(`Rectangle restored from frame ${currentFrameIndex + 1} forward`, 'success', 2000);

            updateFrameInfo();
            updateRectangles();

            // Auto-save after restoring rectangle
            autoSaveRectangles();
        }
    }
}

function removeRectangleFromCurrentFrame(rectId) {
    console.log(`Adding removal marker for rectId: ${rectId} on frame ${currentFrameIndex}`);
    
    // Parse the rectangle ID to get the origin frame
    const rectIdParts = rectId.split('_');
    const originFrame = parseInt(rectIdParts[0]);
    
    // Check if we're deleting from the origin frame
    if (currentFrameIndex === originFrame) {
        console.log(`Deleting rectangle ${rectId} from its origin frame ${originFrame} - complete removal`);
        
        // Remove the original rectangle from its origin frame
        if (frameRectangles[originFrame]) {
            const originalLength = frameRectangles[originFrame].length;
            frameRectangles[originFrame] = frameRectangles[originFrame].filter(rect => {
                const currentRectId = rect.rectangleId || `${originFrame}_${frameRectangles[originFrame].indexOf(rect)}`;
                return currentRectId !== rectId;
            });
            console.log(`Removed original rectangle ${rectId} from frame ${originFrame}. Length: ${originalLength} -> ${frameRectangles[originFrame].length}`);
            
            // Clean up origin frame if empty
            if (frameRectangles[originFrame].length === 0) {
                delete frameRectangles[originFrame];
                console.log(`Deleted empty origin frame ${originFrame}`);
            }
        }
        
        // Remove all subsequent changes (moves, resizes, removals) for this rectangle
        for (let frameIndex = originFrame + 1; frameIndex < totalFrames; frameIndex++) {
            if (frameRectangles[frameIndex]) {
                frameRectangles[frameIndex] = frameRectangles[frameIndex].filter(rect => {
                    // Remove any modifications or removal markers for this rectangle
                    if (rect.isRemovalMarker && rect.removesRect === rectId) {
                        console.log(`Removed removal marker for ${rectId} from frame ${frameIndex}`);
                        return false;
                    }
                    if (rect.rectangleMoved && rect.rectangleId === rectId) {
                        console.log(`Removed move event for ${rectId} from frame ${frameIndex}`);
                        return false;
                    }
                    if (rect.rectangleResized && rect.rectangleId === rectId) {
                        console.log(`Removed resize event for ${rectId} from frame ${frameIndex}`);
                        return false;
                    }
                    return true;
                });
                
                // Clean up empty frame arrays
                if (frameRectangles[frameIndex].length === 0) {
                    delete frameRectangles[frameIndex];
                }
            }
        }
        
        console.log(`Removed all changes for rectangle ${rectId}, original rectangle preserved`);
    } else {
        // Normal deletion - add removal marker for current frame forward
        if (!frameRectangles[currentFrameIndex]) {
            frameRectangles[currentFrameIndex] = [];
        }

        // Add a special rectangle that marks the removal
        frameRectangles[currentFrameIndex].push({
            removesRect: rectId,
            isRemovalMarker: true
        });
        console.log(`Added removal marker for ${rectId} starting from frame ${currentFrameIndex}`);
    }
    
    console.log(`Current frameRectangles[${currentFrameIndex}]:`, frameRectangles[currentFrameIndex]);
    
    // Update frame info and rectangles display
    updateFrameInfo();
    updateRectangles();
    
    // Update timeline scrubber and keyframes to reflect changes
    updateTimelineScrubber();
    
    // Auto-save the changes
    autoSaveRectangles();
}

function getCurrentFrameRectangles() {
    // Get only rectangles that were actually created on current frame (not inherited ones)
    const currentRects = frameRectangles[currentFrameIndex] || [];
    return currentRects.filter(rect => !rect.isRemovalMarker);
}

function selectRectangle(rectDiv, index, rect) {
    // Clear previous selection
    document.querySelectorAll('.rectangle').forEach(r => {
        r.classList.remove('selected');
        r.querySelectorAll('.resize-handle').forEach(h => h.remove());
    });

    // Select new rectangle
    rectDiv.classList.add('selected');
    selectedRect = { element: rectDiv, index: index, rect: rect };

    // Update property table with selected rectangle
    updatePropertyTable();

    // Enable track button if a rectangle is selected
    const trackBtn = document.getElementById('trackBtn');
    if (trackBtn) {
        trackBtn.disabled = false;
    }

    // Add resize handles
    addResizeHandles(rectDiv, index);
}

function addResizeHandles(rectDiv, index) {
    const handles = ['nw', 'ne', 'sw', 'se', 'n', 's', 'w', 'e'];

    handles.forEach(direction => {
        const handle = document.createElement('div');
        handle.className = `resize-handle ${direction}`;
        handle.onmousedown = (e) => {
            e.stopPropagation();
            startResizing(e, direction, index);
        };
        rectDiv.appendChild(handle);
    });
}

function updateFrameInfo() {
    const frameInfo = document.getElementById('frameInfo');
    const activeRects = getActiveRectanglesForFrame(currentFrameIndex);
    const currentFrameRects = getCurrentFrameRectangles();
    const totalActiveRects = Object.keys(frameRectangles).reduce((sum, frameIndex) => {
        return sum + getActiveRectanglesForFrame(parseInt(frameIndex)).length;
    }, 0);
    const framesWithChanges = getFramesWithChanges();
    frameInfo.textContent = `Frame ${currentFrameIndex + 1}/${totalFrames} (${formatTime(currentFrameIndex / videoFPS)}) | Active: ${activeRects.length} | Current Frame: ${currentFrameRects.length} | Keyframes: ${framesWithChanges.length}`;
}

function startDragging(e, rectDiv, index, rect) {
    isDragging = true;
    const frameRect = frameDisplay.getBoundingClientRect();
    const rectStyle = rectDiv.getBoundingClientRect();

    dragOffset.x = e.clientX - rectStyle.left;
    dragOffset.y = e.clientY - rectStyle.top;

    selectRectangle(rectDiv, index, rect);
}

function startResizing(e, direction, index) {
    e.preventDefault(); // Prevent text selection and other default behaviors
    isResizing = true;
    resizeHandle = direction;
    selectedRect.index = index;

    const rect = frameDisplay.getBoundingClientRect();
    startX = e.clientX - rect.left;
    startY = e.clientY - rect.top;
}

function clearRectangles() {
    console.log(`Clearing rectangles for frame ${currentFrameIndex}`);
    if (frameRectangles[currentFrameIndex]) {
        console.log(`Removed ${frameRectangles[currentFrameIndex].length} rectangles from frame ${currentFrameIndex}`);
        delete frameRectangles[currentFrameIndex];
    }

    selectedRect = null;
    updateFrameInfo();
    updateRectangles();
}

function clearRectangles() {
    console.log(`Clearing rectangles for frame ${currentFrameIndex}`);
    if (frameRectangles[currentFrameIndex]) {
        console.log(`Removed ${frameRectangles[currentFrameIndex].length} rectangles from frame ${currentFrameIndex}`);
        delete frameRectangles[currentFrameIndex];
    }

    selectedRect = null;
    updateFrameInfo();
    updateRectangles();

    // Auto-save after clearing rectangles
    autoSaveRectangles();
}

// Unified rectangle data preparation for both export and save
function prepareRectangleData(includeEvents = false) {
    const preparedData = {};

    if (includeEvents) {
        // For save operations - include both actual rectangles AND removal markers
        // This preserves the complete event history for reconstruction later
        for (const [frameIndex, rectangles] of Object.entries(frameRectangles)) {
            const actualRectangles = rectangles.filter(rect =>
                rect.hasOwnProperty('x') &&
                rect.hasOwnProperty('y') &&
                rect.hasOwnProperty('width') &&
                rect.hasOwnProperty('height')
            );
            const removalMarkers = rectangles.filter(rect => rect.isRemovalMarker);

            // Combine actual rectangles with removal markers
            const allItems = [...actualRectangles, ...removalMarkers];
            if (allItems.length > 0) {
                preparedData[frameIndex] = allItems;
            }
        }
    } else {
        // For export operations - calculate active rectangles for each frame
        // This provides the final state of rectangles visible at each frame
        for (let frameIndex = 0; frameIndex < totalFrames; frameIndex++) {
            const activeRects = getActiveRectanglesForFrame(frameIndex);
            if (activeRects.length > 0) {
                preparedData[frameIndex] = activeRects.map(rect => ({
                    x: rect.x,
                    y: rect.y,
                    width: rect.width,
                    height: rect.height
                }));
            }
        }
    }

    console.log(`prepareRectangleData(includeEvents=${includeEvents}):`, preparedData);
    return preparedData;
}

// Auto-save functionality
let autoSaveTimeout = null;
let isAutoSaving = false;

function autoSaveRectangles() {
    console.log('autoSaveRectangles called, currentVideo:', currentVideo);
    // Clear any existing timeout
    if (autoSaveTimeout) {
        clearTimeout(autoSaveTimeout);
    }

    // Set a new timeout to save after 1 second of inactivity
    autoSaveTimeout = setTimeout(() => {
        if (!isAutoSaving && currentVideo) {
            isAutoSaving = true;
            console.log('Auto-saving rectangle data...');
            console.log('Frame rectangles to save:', frameRectangles);

            // Use the same save logic as manual save
            saveRectanglesData().then(() => {
                isAutoSaving = false;
                console.log('Auto-save completed successfully');
            }).catch(error => {
                console.error('Auto-save failed:', error);
                isAutoSaving = false;
            });
        }
    }, 1000); // Save after 1 second of inactivity
}

async function saveRectanglesData() {
    // Check if any frame has rectangles
    const hasRectangles = Object.keys(frameRectangles).length > 0;
    if (!hasRectangles) {
        console.log('No rectangles to save, skipping auto-save');
        return; // Don't save if no rectangles
    }

    // Use unified data preparation for save (include events)
    const filteredFrameRectangles = prepareRectangleData(true);
    console.log('Filtered frame rectangles to save:', filteredFrameRectangles);

    try {
        const payload = {
            video_name: currentVideo,
            all_frame_rectangles: filteredFrameRectangles,
            timestamp: new Date().toISOString(),
            auto_save: true // Mark as auto-save
        };
        console.log('Sending save request with payload:', payload);

        const response = await fetch('/save_rectangles', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(payload)
        });

        const result = await response.json();
        console.log('Save response:', result);
        if (result.error) {
            console.error('Auto-save error:', result.error);
            showStatus(`Auto-save error: ${result.error}`, 'error');
        } else {
            console.log('Auto-save completed successfully');
            // Calculate total rectangles from current data
            const totalRectangles = Object.values(frameRectangles).reduce((total, rects) => {
                return total + rects.filter(r => !r.isRemovalMarker).length;
            }, 0);
            // Show subtle notification for auto-save (less intrusive than manual save)
            showToast(`Auto-saved ${totalRectangles} rectangles`, 'success', 2000);
        }
    } catch (error) {
        console.error('Auto-save failed:', error);
        showStatus('Auto-save failed: ' + error.message, 'error');
    }
}

async function loadExistingRectangles() {
    if (!currentVideo) {
        console.log('No current video to load rectangles for');
        return;
    }

    try {
        console.log(`Loading existing rectangles for ${currentVideo}`);
        const response = await fetch(`/load_rectangles/${currentVideo}`);
        const data = await response.json();
        console.log('Load rectangles response:', data);

        if (data.success && data.frame_rectangles && Object.keys(data.frame_rectangles).length > 0) {
            // Merge with existing rectangles (in case user already added some)
            frameRectangles = { ...frameRectangles, ...data.frame_rectangles };
            console.log('Merged frameRectangles:', frameRectangles);

            console.log(`Loaded ${data.total_rectangles} rectangles across ${data.total_frames} frames`);
            showStatus(`Loaded ${data.total_rectangles} existing rectangles from ${data.filename}`, 'success');

            // Update the display
            updateFrameInfo();
            updateRectangles();
        } else {
            console.log('No existing rectangle data found for this video');
        }
    } catch (error) {
        console.error('Error loading existing rectangles:', error);
        // Don't show error to user as this is optional functionality
    }
}

function debugRectangleState() {
    console.log('=== Rectangle State Debug ===');
    console.log('Current frame:', currentFrameIndex);
    console.log('All frame rectangles:', frameRectangles);
    console.log('Current frame rectangles:', frameRectangles[currentFrameIndex] || []);
    console.log('Previous frame rectangles:', frameRectangles[currentFrameIndex - 1] || []);
    console.log('Total rectangles across all frames:', Object.values(frameRectangles).reduce((sum, rects) => sum + rects.length, 0));
    console.log('============================');
}

async function saveRectangles() {
    // Check if any frame has rectangles
    const hasRectangles = Object.keys(frameRectangles).length > 0;
    if (!hasRectangles) {
        showStatus('No rectangles to save', 'error');
        return;
    }

    showToast('Saving rectangle data...', 'info', 2000);

    // Use unified data preparation for save (include events)
    const filteredFrameRectangles = prepareRectangleData(true);

    try {
        const response = await fetch('/save_rectangles', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                video_name: currentVideo,
                all_frame_rectangles: filteredFrameRectangles,
                timestamp: new Date().toISOString()
            })
        });

        const result = await response.json();
        if (result.error) {
            showStatus(`Save error: ${result.error}`, 'error');
        } else {
            const downloadUrl = `/download_rectangles/${result.filename}`;
            // Create toast with download link
            const downloadMessage = `Saved ${result.total_rectangles} rectangles across ${result.total_frames} frames. <a href="${downloadUrl}" download style="color: #52b788; text-decoration: underline; font-weight: bold;">Download ${result.filename}</a>`;
            showToastWithHTML(downloadMessage, 'success', 8000);
        }
    } catch (error) {
        showStatus('Error saving rectangles: ' + error.message, 'error');
    }
}

let exportAbortController = null;

function showExportModal() {
    document.getElementById('exportModal').style.display = 'flex';
    resetExportModal();
}

function hideExportModal() {
    document.getElementById('exportModal').style.display = 'none';
}

function resetExportModal() {
    // Reset all steps to pending
    ['step1', 'step2', 'step3', 'step4'].forEach(stepId => {
        const step = document.getElementById(stepId);
        step.className = 'export-step pending';
        step.querySelector('.step-status').textContent = 'pending';
        step.querySelector('.step-icon').textContent = '⏳';
    });

    // Reset details
    document.getElementById('framesCount').textContent = '-';
    document.getElementById('rectanglesCount').textContent = '-';
    document.getElementById('audioStatus').textContent = 'Checking...';
    document.getElementById('progressText').textContent = 'Starting...';
    document.getElementById('progressBarFill').style.width = '0%';
    document.getElementById('cancelExport').disabled = false;
}

function updateExportStep(stepId, status, text = null) {
    const step = document.getElementById(stepId);
    step.className = `export-step ${status}`;

    const statusElement = step.querySelector('.step-status');
    const iconElement = step.querySelector('.step-icon');

    if (status === 'active') {
        statusElement.textContent = 'running';
        iconElement.textContent = '🔄';
    } else if (status === 'completed') {
        statusElement.textContent = 'done';
        iconElement.textContent = '✅';
    } else if (status === 'error') {
        statusElement.textContent = 'error';
        iconElement.textContent = '❌';
    }

    if (text) {
        step.querySelector('.step-text').textContent = text;
    }
}

function updateExportProgress(percent, text) {
    document.getElementById('progressBarFill').style.width = percent + '%';
    document.getElementById('progressText').textContent = text;
}

function updateExportDetails(frameCount, rectCount, audioStatus) {
    if (frameCount !== undefined) {
        document.getElementById('framesCount').textContent = frameCount;
    }
    if (rectCount !== undefined) {
        document.getElementById('rectanglesCount').textContent = rectCount;
    }
    if (audioStatus !== undefined) {
        document.getElementById('audioStatus').textContent = audioStatus;
    }
}

function startProgressPolling() {
    if (progressPollingInterval) {
        clearInterval(progressPollingInterval);
    }
    
    progressPollingInterval = setInterval(async () => {
        if (!currentJobId) return;
        
        try {
            const response = await fetch(`/export_progress/${currentJobId}`);
            const job = await response.json();
            
            if (job.error) {
                console.error('Error polling progress:', job.error);
                return;
            }
            
            // Update UI based on job status
            updateProgressFromJob(job);
            
            // Stop polling if job is finished
            if (job.status === 'completed' || job.status === 'error' || job.status === 'cancelled') {
                clearInterval(progressPollingInterval);
                progressPollingInterval = null;
                handleJobCompletion(job);
            }
            
        } catch (error) {
            console.error('Error polling progress:', error);
        }
    }, 1000); // Poll every second
}

function updateProgressFromJob(job) {
    const status = job.status;
    let progress = job.progress || 0;
    
    if (status === 'initializing') {
        updateExportStep('step2', 'active');
        updateExportProgress(20, 'Initializing frame processing...');
    } else if (status === 'processing_frames') {
        updateExportStep('step2', 'active');
        const processed = job.processed_frames || 0;
        const total = job.total_frames || 1;
        updateExportProgress(20 + (progress * 0.6), `Processing frames with blur... (${processed}/${total} - ${Math.round(progress)}%)`);
    } else if (status === 'encoding') {
        updateExportStep('step2', 'completed');
        updateExportStep('step3', 'completed', 'Frames processed');
        updateExportStep('step4', 'active');
        
        // Show detailed encoding progress
        const encodingProgress = job.encoding_progress || 0;
        const encodingFrame = job.encoding_frame || 0;
        const totalFrames = job.total_frames || job.frame_count || 1;
        const speed = job.encoding_speed || 'N/A';
        const bitrate = job.encoding_bitrate || 'N/A';
        
        let encodingMessage = `Encoding final video... (${Math.round(encodingProgress)}%)`;
        if (encodingFrame > 0) {
            encodingMessage = `Encoding video: ${encodingFrame}/${totalFrames} frames (${Math.round(encodingProgress)}%) Speed: ${speed}`;
        }
        
        updateExportProgress(progress, encodingMessage);
    }
}

function handleJobCompletion(job) {
    if (job.status === 'completed') {
        updateExportStep('step2', 'completed');
        updateExportStep('step3', 'completed', 'Audio track included');
        updateExportStep('step4', 'completed');
        updateExportProgress(100, 'Export completed!');
        
        // Update audio status
        const audioStatus = job.has_audio ? 'Included' : 'Not available';
        updateExportDetails(undefined, undefined, audioStatus);
        
        document.getElementById('cancelExport').disabled = true;
        
        setTimeout(() => {
            hideExportModal();
            // Different message for preview vs full export
            const isPreview = job.filename && job.filename.startsWith('preview_');
            const defaultMessage = isPreview ? 'Preview completed successfully!' : 'Export completed successfully!';
            showToast(job.message || defaultMessage, 'success', 8000);
            
            // Show preview link if this was a preview job
            if (isPreview && job.filename) {
                showPreviewLink(job.filename);
            }
            
            currentJobId = null;
        }, 2000);
        
    } else if (job.status === 'error') {
        updateExportStep('step2', 'error');
        updateExportStep('step3', 'error');
        updateExportStep('step4', 'error');
        updateExportProgress(0, 'Export failed');
        
        setTimeout(() => {
            hideExportModal();
            showToast(job.error || 'Export failed', 'error');
            currentJobId = null;
        }, 2000);
        
    } else if (job.status === 'cancelled') {
        updateExportStep('step2', 'error');
        updateExportStep('step3', 'error');
        updateExportStep('step4', 'error');
        updateExportProgress(0, 'Export cancelled');
        
        setTimeout(() => {
            hideExportModal();
            showToast('Export cancelled by user', 'warning');
            currentJobId = null;
        }, 1000);
    }
}

async function cancelExport() {
    if (currentJobId) {
        try {
            await fetch(`/cancel_export/${currentJobId}`, { method: 'POST' });
            // The polling will handle the UI update when it detects cancellation
        } catch (error) {
            console.error('Error cancelling export:', error);
            hideExportModal();
            showToast('Error cancelling export', 'error');
        }
    } else {
        hideExportModal();
        showToast('Export cancelled', 'warning');
    }
}

async function previewBlurred() {
    // Hide any existing preview link
    hidePreviewLink();
    
    // Find first frame with rectangles
    const framesWithRects = getFramesWithChanges();
    if (framesWithRects.length === 0) {
        showToast('No rectangles found to preview', 'error');
        return;
    }

    const startFrame = framesWithRects[0];
    const endFrame = Math.min(startFrame + 200, totalFrames - 1);

    showToast(`Creating preview from frame ${startFrame + 1} to ${endFrame + 1} (${endFrame - startFrame + 1} frames)`, 'info', 3000);

    // Show the export modal
    showExportModal();

    // Step 1: Analyze and build export data (same as export but limited frames)
    updateExportStep('step1', 'active');
    updateExportProgress(10, 'Analyzing rectangles for preview...');

    // Create export data in JSON events format to preserve rectangleId tracking
    const exportData = {
        frames: []
    };
    
    // Convert frameRectangles to structured event format (only for preview range)
    let totalRectangles = 0;
    for (const [frameIndex, rectangles] of Object.entries(frameRectangles)) {
        const frameNum = parseInt(frameIndex);
        if (frameNum < startFrame || frameNum > endFrame) continue; // Skip frames outside preview range
        if (!rectangles || rectangles.length === 0) continue;
        
        const frameData = {
            frame_number: frameNum,
            events: []
        };
        
        for (const rect of rectangles) {
            if (rect.isRemovalMarker) {
                frameData.events.push({
                    eventType: 'rectangleDeleted',
                    rectangleId: rect.removesRect
                });
            } else if (rect.rectangleMoved) {
                frameData.events.push({
                    eventType: 'rectangleMoved',
                    rectangleId: rect.rectangleMoved,
                    x: rect.x,
                    y: rect.y,
                    width: rect.width,
                    height: rect.height
                });
                totalRectangles++;
            } else if (rect.rectangleResized) {
                frameData.events.push({
                    eventType: 'rectangleResized',
                    rectangleId: rect.rectangleResized,
                    x: rect.x,
                    y: rect.y,
                    width: rect.width,
                    height: rect.height
                });
                totalRectangles++;
            } else if (rect.hasOwnProperty('x') && rect.rectangleId) {
                frameData.events.push({
                    eventType: 'rectangleCreated',
                    rectangleId: rect.rectangleId,
                    x: rect.x,
                    y: rect.y,
                    width: rect.width,
                    height: rect.height
                });
                totalRectangles++;
            }
        }
        
        if (frameData.events.length > 0) {
            exportData.frames.push(frameData);
        }
    }

    const framesWithRectsInRange = exportData.frames.length;
    updateExportDetails(framesWithRectsInRange, totalRectangles, 'Checking...');

    updateExportStep('step1', 'completed');
    updateExportProgress(25, 'Sending preview request...');

    try {
        // Create AbortController for cancellation
        exportAbortController = new AbortController();

        // Get selected codec and blur amount
        const codecSelect = document.getElementById('codecSelect');
        const selectedCodec = codecSelect.value;
        const blurSelect = document.getElementById('blurAmount');
        const selectedBlur = parseInt(blurSelect.value);

        // Start the preview job
        const response = await fetch('/preview_blurred', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                video_name: currentVideo,
                frames: exportData.frames,
                blur_radius: selectedBlur,
                video_codec: selectedCodec,
                start_frame: startFrame,
                end_frame: endFrame
            })
        });

        const startResult = await response.json();
        
        if (startResult.error) {
            updateExportStep('step1', 'error');
            updateExportProgress(0, 'Failed to start preview');
            setTimeout(() => {
                hideExportModal();
                showToast(`Preview error: ${startResult.error}`, 'error');
            }, 2000);
            return;
        }

        // Store job ID and start polling
        currentJobId = startResult.job_id;
        updateExportStep('step1', 'completed');
        updateExportProgress(15, 'Preview job started...');

        // Start polling for progress
        startProgressPolling();
    } catch (error) {
        updateExportStep('step1', 'error');
        updateExportStep('step2', 'error');
        updateExportStep('step3', 'error');
        updateExportStep('step4', 'error');
        updateExportProgress(0, 'Preview failed');

        setTimeout(() => {
            hideExportModal();
            showToast('Error starting preview: ' + error.message, 'error');
        }, 2000);
    }
}

let currentJobId = null;
let progressPollingInterval = null;

async function exportBlurred() {
    // Show the export modal
    showExportModal();

    // Step 1: Analyze and build export data
    updateExportStep('step1', 'active');
    updateExportProgress(10, 'Analyzing rectangles...');

    // Create export data in JSON events format to preserve rectangleId tracking
    const exportData = {
        frames: []
    };

    // Convert frameRectangles to structured event format
    let totalRectangles = 0;
    for (const [frameIndex, rectangles] of Object.entries(frameRectangles)) {
        if (!rectangles || rectangles.length === 0) continue;

        const frameData = {
            frame_number: parseInt(frameIndex),
            events: []
        };

        for (const rect of rectangles) {
            if (rect.isRemovalMarker) {
                // Handle deletion event
                frameData.events.push({
                    eventType: 'rectangleDeleted',
                    rectangleId: rect.removesRect
                });
            } else if (rect.rectangleMoved) {
                // Handle move event
                frameData.events.push({
                    eventType: 'rectangleMoved',
                    rectangleId: rect.rectangleMoved,
                    x: rect.x,
                    y: rect.y,
                    width: rect.width,
                    height: rect.height
                });
                totalRectangles++;
            } else if (rect.rectangleResized) {
                // Handle resize event
                frameData.events.push({
                    eventType: 'rectangleResized',
                    rectangleId: rect.rectangleResized,
                    x: rect.x,
                    y: rect.y,
                    width: rect.width,
                    height: rect.height
                });
                totalRectangles++;
            } else if (rect.hasOwnProperty('x') && rect.rectangleId) {
                // Handle creation event
                frameData.events.push({
                    eventType: 'rectangleCreated',
                    rectangleId: rect.rectangleId,
                    x: rect.x,
                    y: rect.y,
                    width: rect.width,
                    height: rect.height
                });
                totalRectangles++;
            }
        }

        if (frameData.events.length > 0) {
            exportData.frames.push(frameData);
        }
    }

    const framesWithRects = exportData.frames.length;
    updateExportDetails(framesWithRects, totalRectangles, 'Checking...');

    // Check if any frame has rectangles
    if (framesWithRects === 0) {
        updateExportStep('step1', 'error');
        updateExportProgress(0, 'No rectangles found');
        setTimeout(() => {
            hideExportModal();
            showToast('No rectangles to blur across any frames', 'error');
        }, 2000);
        return;
    }

    updateExportStep('step1', 'completed');
    updateExportProgress(25, 'Sending export request...');

    try {
        // Get selected codec and blur amount
        const codecSelect = document.getElementById('codecSelect');
        const selectedCodec = codecSelect.value;
        const blurSelect = document.getElementById('blurAmount');
        const selectedBlur = parseInt(blurSelect.value);

        // Start the export job
        const response = await fetch('/export_blurred', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                video_name: currentVideo,
                frames: exportData.frames,  // Send in events format
                blur_radius: selectedBlur,  // Use selected blur amount
                video_codec: selectedCodec  // Include selected codec
            })
        });

        const startResult = await response.json();
        
        if (startResult.error) {
            updateExportStep('step1', 'error');
            updateExportProgress(0, 'Failed to start export');
            setTimeout(() => {
                hideExportModal();
                showToast(`Export error: ${startResult.error}`, 'error');
            }, 2000);
            return;
        }

        // Store job ID and start polling
        currentJobId = startResult.job_id;
        updateExportStep('step1', 'completed');
        updateExportProgress(15, 'Export job started...');

        // Start polling for progress
        startProgressPolling();

    } catch (error) {
        updateExportStep('step1', 'error');
        updateExportStep('step2', 'error');
        updateExportStep('step3', 'error');
        updateExportStep('step4', 'error');
        updateExportProgress(0, 'Export failed');

        setTimeout(() => {
            hideExportModal();
            showToast('Error starting export: ' + error.message, 'error');
        }, 2000);
    }
}

function showToast(message, type = 'success', duration = 5000) {
    const container = document.getElementById('toastContainer');

    // Create toast element
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;

    // Get appropriate icon
    let icon = '✓';
    if (type === 'error') icon = '✕';
    else if (type === 'warning') icon = '⚠';
    else if (type === 'info') icon = 'ℹ';

    // Build toast HTML
    toast.innerHTML = `
        <span class="toast-icon">${icon}</span>
        <div class="toast-message">${message}</div>
        <span class="toast-close" onclick="removeToast(this.parentElement)">×</span>
    `;

    // Add to container
    container.appendChild(toast);

    // Trigger animation
    setTimeout(() => {
        toast.classList.add('show');
    }, 10);

    // Auto remove after duration
    setTimeout(() => {
        removeToast(toast);
    }, duration);

    return toast;
}

function showToastWithHTML(htmlMessage, type = 'success', duration = 5000) {
    const container = document.getElementById('toastContainer');

    // Create toast element
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;

    // Get appropriate icon
    let icon = '✓';
    if (type === 'error') icon = '✕';
    else if (type === 'warning') icon = '⚠';
    else if (type === 'info') icon = 'ℹ';

    // Build toast HTML with raw HTML message
    toast.innerHTML = `
        <span class="toast-icon">${icon}</span>
        <div class="toast-message">${htmlMessage}</div>
        <span class="toast-close" onclick="removeToast(this.parentElement)">×</span>
    `;

    // Add to container
    container.appendChild(toast);

    // Trigger animation
    setTimeout(() => {
        toast.classList.add('show');
    }, 10);

    // Auto remove after duration
    setTimeout(() => {
        removeToast(toast);
    }, duration);

    return toast;
}

function removeToast(toast) {
    if (!toast || !toast.parentElement) return;

    toast.classList.remove('show');
    setTimeout(() => {
        if (toast.parentElement) {
            toast.parentElement.removeChild(toast);
        }
    }, 300);
}

// Legacy function for backward compatibility
function showStatus(message, type) {
    showToast(message, type);
}


function setFrameSize(size) {
    const frameDisplay = document.getElementById('frameDisplay');

    let width, height;
    switch (size) {
        case 'small':
            width = '400px';
            height = '300px';
            break;
        case 'medium':
            width = '600px';
            height = '450px';
            break;
        case 'large':
            width = '800px';
            height = '600px';
            break;
        case 'fit':
            width = '90vw';
            height = '70vh';
            break;
    }

    frameDisplay.style.width = width;
    frameDisplay.style.height = height;

    // Update frame size display after setting new size
    setTimeout(() => {
        updateFrameSizeDisplay();
    }, 50);
}

function setCustomSize(value) {
    const frameDisplay = document.getElementById('frameDisplay');

    const width = value + 'px';
    const height = (value * 0.75) + 'px'; // Maintain 4:3 aspect ratio

    frameDisplay.style.width = width;
    frameDisplay.style.height = height;

    // Update frame size display after setting custom size
    setTimeout(() => {
        updateFrameSizeDisplay();
    }, 50);
}

function navigateFrame(direction) {
    if (totalFrames === 0) return;

    let newIndex = currentFrameIndex + direction;
    if (newIndex < 0) newIndex = 0;
    if (newIndex >= totalFrames) newIndex = totalFrames - 1;

    if (newIndex !== currentFrameIndex) {
        showFrame(newIndex);
    }
}

function startPlayback() {
    if (totalFrames === 0) return;
    
    isPlaying = true;
    const frameDelay = 1000 / videoFPS; // Convert FPS to milliseconds per frame
    
    playbackInterval = setInterval(() => {
        let nextFrame = currentFrameIndex + 1;
        
        // Loop back to start when reaching the end
        if (nextFrame >= totalFrames) {
            nextFrame = 0;
        }
        
        showFrame(nextFrame);
    }, frameDelay);
}

function stopPlayback() {
    isPlaying = false;
    if (playbackInterval) {
        clearInterval(playbackInterval);
        playbackInterval = null;
    }
}

function togglePlayback() {
    if (isPlaying) {
        stopPlayback();
    } else {
        startPlayback();
    }
}

function getFramesWithChanges() {
    const framesWithChanges = new Set();

    // Get all frames that have rectangle data
    const frameNumbers = Object.keys(frameRectangles).map(f => parseInt(f)).sort((a, b) => a - b);

    console.log('getFramesWithChanges - frameRectangles:', frameRectangles);
    console.log('getFramesWithChanges - frameNumbers:', frameNumbers);

    for (let frameNum of frameNumbers) {
        const rects = frameRectangles[frameNum];
        console.log(`Frame ${frameNum} has ${rects.length} rectangles:`, rects);

        // Check if this frame has any meaningful content
        // Only add as keyframe if frame has actual rectangles or modifications that result in visible changes
        let hasContent = false;

        // Check for new rectangles (additions)
        const actualRects = rects.filter(r => !r.isRemovalMarker && !r.rectangleMoved && !r.rectangleResized);
        if (actualRects.length > 0) {
            console.log(`Frame ${frameNum} has ${actualRects.length} actual rectangles - adding to keyframes`);
            hasContent = true;
        }

        // Check for rectangleMoved entries
        const movedRects = rects.filter(r => r.rectangleMoved);
        if (movedRects.length > 0) {
            console.log(`Frame ${frameNum} has ${movedRects.length} moved rectangles - adding to keyframes`);
            hasContent = true;
        }

        // Check for rectangleResized entries
        const resizedRects = rects.filter(r => r.rectangleResized);
        if (resizedRects.length > 0) {
            console.log(`Frame ${frameNum} has ${resizedRects.length} resized rectangles - adding to keyframes`);
            hasContent = true;
        }

        // For removal markers, only add as keyframe if there are still active rectangles on this frame
        const removals = rects.filter(r => r.isRemovalMarker);
        if (removals.length > 0) {
            // Check if this frame has any active rectangles (using the full inheritance system)
            const activeRects = getActiveRectanglesForFrame(frameNum);
            if (activeRects.length > 0) {
                console.log(`Frame ${frameNum} has ${removals.length} removal markers but still has ${activeRects.length} active rectangles - adding to keyframes`);
                hasContent = true;
            } else {
                console.log(`Frame ${frameNum} has ${removals.length} removal markers but no active rectangles - NOT adding to keyframes`);
            }
        }

        if (hasContent) {
            framesWithChanges.add(frameNum);
        }
    }

    const result = Array.from(framesWithChanges).sort((a, b) => a - b);
    console.log('getFramesWithChanges - framesWithChanges:', result);
    console.log('getFramesWithChanges - Total changes detected:', result.length);
    return result;
}

function navigateToPreviousChange() {
    if (totalFrames === 0) {
        showStatus('No video loaded', 'error');
        return;
    }

    const framesWithChanges = getFramesWithChanges();

    if (framesWithChanges.length === 0) {
        showStatus('No keyframes found', 'error');
        return;
    }

    // Find the previous keyframe before current frame
    let previousChangeFrame = null;
    for (let i = framesWithChanges.length - 1; i >= 0; i--) {
        const frameNum = framesWithChanges[i];
        if (frameNum < currentFrameIndex) {
            previousChangeFrame = frameNum;
            break;
        }
    }

    // If no keyframes found before current frame, wrap to the last keyframe
    if (previousChangeFrame === null) {
        previousChangeFrame = framesWithChanges[framesWithChanges.length - 1];
        if (previousChangeFrame === currentFrameIndex) {
            // If current frame is the only keyframe
            if (framesWithChanges.length === 1) {
                showStatus('Only one keyframe exists', 'error');
                return;
            } else {
                // Go to the second-to-last keyframe
                previousChangeFrame = framesWithChanges[framesWithChanges.length - 2];
            }
        }
    }

    showFrame(previousChangeFrame);

    // Show info about what's happening at this frame
    const rects = frameRectangles[previousChangeFrame] || [];
    const additions = rects.filter(r => !r.isRemovalMarker && !r.rectangleMoved && !r.rectangleResized).length;
    const deletions = rects.filter(r => r.isRemovalMarker).length;
    const moved = rects.filter(r => r.rectangleMoved).length;
    const resized = rects.filter(r => r.rectangleResized).length;

    let message = `Previous change: Frame ${previousChangeFrame + 1}`;
    let changeInfo = [];
    if (additions > 0) changeInfo.push(`${additions} addition${additions > 1 ? 's' : ''}`);
    if (deletions > 0) changeInfo.push(`${deletions} deletion${deletions > 1 ? 's' : ''}`);
    if (moved > 0) changeInfo.push(`${moved} moved${moved > 1 ? 's' : ''}`);
    if (resized > 0) changeInfo.push(`${resized} resized${resized > 1 ? 's' : ''}`);

    if (changeInfo.length > 0) {
        message += ` (${changeInfo.join(', ')})`;
    }

    showToast(message, 'info', 3000);
}

function navigateToNextChange() {
    if (totalFrames === 0) {
        showStatus('No video loaded', 'error');
        return;
    }

    const framesWithChanges = getFramesWithChanges();

    if (framesWithChanges.length === 0) {
        showStatus('No keyframes found', 'error');
        return;
    }

    // Find the next keyframe after current frame
    let nextChangeFrame = null;
    for (let frameNum of framesWithChanges) {
        if (frameNum > currentFrameIndex) {
            nextChangeFrame = frameNum;
            break;
        }
    }

    // If no keyframes found after current frame, wrap to the first keyframe
    if (nextChangeFrame === null) {
        nextChangeFrame = framesWithChanges[0];
        if (nextChangeFrame === currentFrameIndex) {
            // If current frame is the only keyframe
            if (framesWithChanges.length === 1) {
                showStatus('Only one keyframe exists', 'error');
                return;
            } else {
                // Go to the second keyframe
                nextChangeFrame = framesWithChanges[1];
            }
        }
    }

    showFrame(nextChangeFrame);

    // Show info about what's happening at this frame
    const rects = frameRectangles[nextChangeFrame] || [];
    const additions = rects.filter(r => !r.isRemovalMarker && !r.rectangleMoved && !r.rectangleResized).length;
    const removals = rects.filter(r => r.isRemovalMarker).length;
    const moved = rects.filter(r => r.rectangleMoved).length;
    const resized = rects.filter(r => r.rectangleResized).length;

    let changeInfo = [];
    if (additions > 0) changeInfo.push(`${additions} addition${additions > 1 ? 's' : ''}`);
    if (removals > 0) changeInfo.push(`${removals} removal${removals > 1 ? 's' : ''}`);
    if (moved > 0) changeInfo.push(`${moved} moved${moved > 1 ? 's' : ''}`);
    if (resized > 0) changeInfo.push(`${resized} resized${resized > 1 ? 's' : ''}`);

}

document.addEventListener('keydown', function (e) {
    // Prevent keyboard shortcuts when typing in input fields
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') {
        return;
    }
    
    if (e.key === 'ArrowLeft') {
        e.preventDefault();
        navigateFrame(-1);
    } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        navigateFrame(1);
    } else if (e.key === ' ') { // Spacebar
        e.preventDefault();
        togglePlayback();
    } else if (e.key === 'd' && e.ctrlKey) {
        e.preventDefault();
        debugRectangleState();
    } else if (e.key === 'n' && e.ctrlKey) {
        e.preventDefault();
        navigateToNextChange();
    } else if (e.key === 'p' && e.ctrlKey) {
        e.preventDefault();
        navigateToPreviousChange();
    }
});

// Add event listener for blur amount changes to update property table
setTimeout(() => {
    const blurSelect = document.getElementById('blurAmount');
    if (blurSelect) {
        blurSelect.addEventListener('change', () => {
            updatePropertyTable();
        });
    }
}, 100);

loadVideos();
checkFFmpegStatus();

// Preview Link Functions
function showPreviewLink(filename) {
    const container = document.getElementById('previewLinkContainer');
    const link = document.getElementById('previewLink');
    
    if (container && link) {
        link.href = `/serve_preview/${filename}`;
        link.title = `Preview: ${filename}`;
        container.style.display = 'block';
        
        // Show toast with additional info
        showToast(`Preview ready! Click the link below to view your video.`, 'success', 5000);
    }
}

function hidePreviewLink() {
    const container = document.getElementById('previewLinkContainer');
    if (container) {
        container.style.display = 'none';
    }
}

// FFmpeg Status Check Function
async function checkFFmpegStatus() {
    try {
        showToast('Checking FFmpeg installation...', 'info', 2000);
        
        const response = await fetch('/check_ffmpeg');
        const result = await response.json();
        
        if (result.available) {
            // Extract version number for cleaner display
            const versionMatch = result.version.match(/ffmpeg version ([\d\.\-\w]+)/i);
            const versionText = versionMatch ? versionMatch[1] : 'Unknown version';
            
            // Update codec dropdown with available encoders
            populateCodecDropdown(result.codec_options);
            
            // Show enhanced status message with hardware encoder info
            let statusMessage = `✅ FFmpeg ${versionText} - Ready for video processing`;
            if (result.hardware_count > 0) {
                statusMessage += ` (${result.hardware_count} hardware encoders detected)`;
            }
            
            showStatus(statusMessage, 'success');
            showToast('FFmpeg ready!', 'success', 2000);
        } else {
            const errorMessage = `❌ FFmpeg not available: ${result.message}`;
            showStatus(errorMessage, 'error');
            showToast('FFmpeg missing!', 'error', 4000);
            
            // Show detailed error in console for debugging
            console.error('FFmpeg check failed:', result);
            
            // Show helpful message
            setTimeout(() => {
                showStatus('⚠️ Please install FFmpeg to use video processing features. Visit https://ffmpeg.org/download.html', 'error');
            }, 3000);
        }
    } catch (error) {
        console.error('Error checking FFmpeg:', error);
        showStatus('❌ Could not verify FFmpeg installation', 'error');
        showToast('FFmpeg check failed', 'error', 3000);
    }
}

// Populate Codec Dropdown Function
function populateCodecDropdown(codecOptions) {
    console.log('populateCodecDropdown called with:', codecOptions);
    const codecSelect = document.getElementById('codecSelect');
    console.log('codecSelect element:', codecSelect);
    
    if (!codecSelect || !codecOptions) {
        console.error('Missing codecSelect element or codecOptions:', {codecSelect, codecOptions});
        return;
    }

    // Clear existing options
    codecSelect.innerHTML = '';
    console.log('Cleared existing options');

    // Add codec options (don't set selected here, do it after all are added)
    codecOptions.forEach((codec, index) => {
        console.log(`Adding codec ${index}:`, codec);
        const option = document.createElement('option');
        option.value = codec.id;
        option.textContent = codec.name;
        codecSelect.appendChild(option);
        console.log(`Added option: ${codec.name} (${codec.id})`);
    });

    // Auto-select preferred codec with priority: NVIDIA H.264 > other hardware > software
    let selectedOption = null;
    
    // First priority: NVIDIA NVENC H.264
    const nvencH264 = Array.from(codecSelect.options).find(option => option.value === 'h264_nvenc');
    if (nvencH264) {
        selectedOption = nvencH264;
        console.log('Auto-selected NVIDIA NVENC H.264 (highest priority)');
    }
    
    // Second priority: Other hardware encoders
    if (!selectedOption) {
        const hardwareOptions = Array.from(codecSelect.options).filter(option => {
            const codec = codecOptions.find(c => c.id === option.value);
            return codec && (codec.type === 'nvidia' || codec.type === 'intel' || codec.type === 'amd');
        });
        if (hardwareOptions.length > 0) {
            selectedOption = hardwareOptions[0];
            console.log(`Auto-selected first hardware encoder: ${selectedOption.textContent}`);
        }
    }
    
    // Third priority: Software encoder (fallback)
    if (!selectedOption) {
        const softwareOption = Array.from(codecSelect.options).find(option => option.value === 'libx264');
        if (softwareOption) {
            selectedOption = softwareOption;
            console.log('Auto-selected software encoder (fallback)');
        }
    }
    
    // Apply selection
    if (selectedOption) {
        // Clear all selections first
        Array.from(codecSelect.options).forEach(opt => opt.selected = false);
        selectedOption.selected = true;
        console.log(`Final selection: ${selectedOption.textContent} (${selectedOption.value})`);
    }

    console.log('Final codec dropdown options:', Array.from(codecSelect.options).map(opt => ({value: opt.value, text: opt.textContent, selected: opt.selected})));
    console.log('Populated codec dropdown with options:', codecOptions);
}

// Cleanup Frames Function
async function cleanupFrames() {
    if (!confirm('This will delete ALL extracted frame files for ALL videos to free disk space.\n\nYou will need to re-extract frames when loading videos again.\n\nAre you sure you want to continue?')) {
        return;
    }

    try {
        showToast('Cleaning up frame files...', 'info', 3000);
        
        const response = await fetch('/cleanup_frames');
        const result = await response.json();
        
        if (result.error) {
            showStatus(`Cleanup failed: ${result.error}`, 'error');
        } else {
            const message = `Successfully cleaned up ${result.folders_deleted} video folders and ${result.files_deleted} frame files. Freed ${result.size_freed} of disk space.`;
            showStatus(message, 'success');
            showToast(`Freed ${result.size_freed}`, 'success', 4000);
            
            // Reset current video state since frames are deleted
            if (currentVideo) {
                document.getElementById('currentFrame').style.display = 'none';
                document.getElementById('timeline').style.display = 'none';
                currentVideo = null;
                totalFrames = 0;
                currentFrameIndex = 0;
                frameRectangles = {};
                showStatus('Frames cleaned up. Please reload your video to continue editing.', 'info');
            }
        }
    } catch (error) {
        console.error('Cleanup error:', error);
        showStatus('Cleanup failed: ' + error.message, 'error');
    }
}

// Object tracking functionality
async function trackSelectedRectangle() {
    if (!selectedRect || !selectedRect.rect) {
        showStatus('Please select a rectangle to track', 'error');
        return;
    }
    
    if (!currentVideo) {
        showStatus('No video loaded', 'error');
        return;
    }
    
    const rect = selectedRect.rect;
    const trackBtn = document.getElementById('trackBtn');
    
    try {
        // Disable button during tracking
        trackBtn.disabled = true;
        trackBtn.textContent = 'Tracking...';
        
        showToast('Starting object tracking...', 'info', 3000);
        
        const response = await fetch('/track_rectangle', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                video_name: currentVideo,
                rectangle: {
                    x: rect.x,
                    y: rect.y,
                    width: rect.width,
                    height: rect.height,
                    rectId: rect.rectId
                },
                start_frame: currentFrameIndex,
                fps: videoFPS
            }),
        });
        
        const result = await response.json();
        
        if (result.success) {
            // Apply tracking results to create move events
            let movesCreated = 0;
            
            for (const trackResult of result.tracking_results) {
                const frameIndex = trackResult.frame;
                
                // Only create moves if position changed significantly
                const prevResult = result.tracking_results[result.tracking_results.indexOf(trackResult) - 1];
                const startPos = prevResult || { x: rect.x, y: rect.y };
                
                const deltaX = Math.abs(trackResult.x - startPos.x);
                const deltaY = Math.abs(trackResult.y - startPos.y);
                
                if (deltaX > 5 || deltaY > 5) { // Only if moved more than 5 pixels
                    // Initialize frame if needed
                    if (!frameRectangles[frameIndex]) {
                        frameRectangles[frameIndex] = [];
                    }
                    
                    // Remove existing move event for this rectangle
                    frameRectangles[frameIndex] = frameRectangles[frameIndex].filter(r => 
                        !(r.rectangleMoved === rect.rectId)
                    );
                    
                    // Add new move event
                    frameRectangles[frameIndex].push({
                        rectangleMoved: rect.rectId,
                        x: trackResult.x,
                        y: trackResult.y,
                        width: trackResult.width,
                        height: trackResult.height
                    });
                    
                    movesCreated++;
                }
            }
            
            // Update UI
            updateRectangles();
            updateFrameInfo();
            updateTimelineScrubber();
            autoSaveRectangles();
            
            showStatus(`Tracking completed! Created ${movesCreated} movement events across ${result.processed_frames} frames`, 'success');
            showToast(`Tracked object through ${result.processed_frames} frames`, 'success', 4000);
            
        } else {
            showStatus('Tracking failed: ' + result.error, 'error');
        }
        
    } catch (error) {
        console.error('Tracking error:', error);
        showStatus('Tracking failed: ' + error.message, 'error');
    } finally {
        // Re-enable button
        trackBtn.disabled = false;
        trackBtn.textContent = 'Track Forward';
    }
}
