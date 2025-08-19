from flask import Flask, render_template, request, jsonify, send_file
import os
import json
import subprocess
import shutil
from PIL import Image, ImageFilter
import base64
from io import BytesIO
import time
import psutil
import gc
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed
import uuid
from threading import Lock
import re
import tempfile

app = Flask(__name__)

UPLOAD_FOLDER = 'data'
FRAMES_FOLDER = 'frames'
EXPORT_FOLDER = 'exports'

for folder in [UPLOAD_FOLDER, FRAMES_FOLDER, EXPORT_FOLDER]:
    os.makedirs(folder, exist_ok=True)

# Job tracking system
jobs = {}
jobs_lock = Lock()

@app.route('/')
def index():
    return render_template('index.html')

@app.route('/get_videos')
def get_videos():
    videos = []
    for file in os.listdir(UPLOAD_FOLDER):
        if file.lower().endswith(('.mp4', '.avi', '.mov', '.mkv')):
            videos.append(file)
    return jsonify(videos)

@app.route('/get_first_video')
def get_first_video():
    try:
        files = os.listdir(UPLOAD_FOLDER)
        print(f"Files in {UPLOAD_FOLDER}: {files}")
        
        for file in files:
            if file.lower().endswith(('.mp4', '.avi', '.mov', '.mkv')):
                print(f"Found video file: {file}")
                return jsonify({'video': file})
        
        print("No video files found")
        return jsonify({'video': None})
    except Exception as e:
        print(f"Error in get_first_video: {e}")
        return jsonify({'error': str(e)}), 500

@app.route('/get_video_info/<video_name>')
def get_video_info(video_name):
    video_path = os.path.join(UPLOAD_FOLDER, video_name)
    
    try:
        cmd = [
            'ffprobe', '-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', video_path
        ]
        result = subprocess.run(cmd, capture_output=True, text=True, check=True)
        info = json.loads(result.stdout)
        
        video_stream = next((s for s in info['streams'] if s['codec_type'] == 'video'), None)
        if video_stream:
            duration = float(info['format']['duration'])
            fps = eval(video_stream['r_frame_rate'])
            total_frames = int(duration * fps)
            
            return jsonify({
                'duration': duration,
                'fps': fps,
                'total_frames': total_frames,
                'width': video_stream['width'],
                'height': video_stream['height']
            })
        
        return jsonify({'error': 'No video stream found'}), 400
        
    except (subprocess.CalledProcessError, FileNotFoundError, json.JSONDecodeError) as e:
        return jsonify({'error': f'Error getting video info: {str(e)}'}), 500

@app.route('/extract_frames/<video_name>')
def extract_frames(video_name):
    video_path = os.path.join(UPLOAD_FOLDER, video_name)
    video_frames_folder = os.path.join(FRAMES_FOLDER, video_name.split('.')[0])
    
    # Check if frames already exist
    if os.path.exists(video_frames_folder):
        frame_files = sorted([f for f in os.listdir(video_frames_folder) if f.startswith('frame_')])
        
        if frame_files:
            print(f"Found existing {len(frame_files)} frames for {video_name}, skipping extraction")
            frames_info = []
            
            for i, filename in enumerate(frame_files):
                frames_info.append({
                    'index': i,
                    'filename': filename,
                    'path': os.path.join(video_frames_folder, filename)
                })
            
            return jsonify({
                'frames': frames_info, 
                'total': len(frame_files),
                'cached': True,
                'message': f'Using existing {len(frame_files)} frames'
            })
    
    # Generate unique job ID for tracking progress
    job_id = str(uuid.uuid4())
    
    # Initialize job tracking for frame extraction
    with jobs_lock:
        jobs[job_id] = {
            'id': job_id,
            'status': 'starting',
            'progress': 0,
            'message': 'Starting frame extraction...',
            'video_name': video_name,
            'total_frames': 0,
            'extracted_frames': 0,
            'created_at': time.time()
        }
    
    # Start extraction in background thread
    thread = threading.Thread(target=extract_frames_async, args=(job_id, video_name, video_path, video_frames_folder))
    thread.daemon = True
    thread.start()
    
    return jsonify({'job_id': job_id, 'message': 'Frame extraction started'})

def extract_frames_async(job_id, video_name, video_path, video_frames_folder):
    """Asynchronous frame extraction with progress tracking"""
    try:
        # Get video duration and frame count first
        with jobs_lock:
            if job_id in jobs:
                jobs[job_id]['status'] = 'analyzing'
                jobs[job_id]['message'] = 'Analyzing video properties...'
        
        # Get video info for progress calculation
        cmd_info = [
            'ffprobe', '-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', video_path
        ]
        result = subprocess.run(cmd_info, capture_output=True, text=True, check=True)
        info = json.loads(result.stdout)
        
        video_stream = next((s for s in info['streams'] if s['codec_type'] == 'video'), None)
        if video_stream:
            duration = float(info['format']['duration'])
            fps = eval(video_stream['r_frame_rate'])
            total_frames = int(duration * 30)  # 30 fps extraction
            
            with jobs_lock:
                if job_id in jobs:
                    jobs[job_id]['total_frames'] = total_frames
                    jobs[job_id]['message'] = f'Extracting {total_frames} frames...'
        else:
            total_frames = 1000  # Fallback estimate
        
        # Create folder if it doesn't exist
        os.makedirs(video_frames_folder, exist_ok=True)
        
        frame_pattern = os.path.join(video_frames_folder, 'frame_%06d.jpg')
        
        # Create temporary file for FFmpeg progress
        with tempfile.NamedTemporaryFile(mode='w+', delete=False, suffix='.txt') as progress_file:
            progress_path = progress_file.name
        
        try:
            with jobs_lock:
                if job_id in jobs:
                    jobs[job_id]['status'] = 'extracting'
                    jobs[job_id]['progress'] = 0
            
            print(f"Extracting frames for {video_name}...")
            cmd = [
                'ffmpeg', '-i', video_path,
                '-vf', 'fps=fps=30',  # Extract at 30 fps for smooth timeline
                '-q:v', '2',  # High quality
                '-y',  # Overwrite existing files
                '-progress', progress_path,  # Progress output
                '-stats_period', '0.5',  # Update every 0.5 seconds
                frame_pattern
            ]
            
            # Start FFmpeg process
            process = subprocess.Popen(
                cmd,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                bufsize=1,
                universal_newlines=True
            )
            
            # Monitor progress in a separate thread
            def monitor_progress():
                last_pos = 0
                while process.poll() is None:
                    try:
                        with open(progress_path, 'r') as f:
                            f.seek(last_pos)
                            content = f.read()
                            last_pos = f.tell()
                            
                            if content:
                                # Parse FFmpeg progress output
                                lines = content.strip().split('\n')
                                current_data = {}
                                
                                for line in lines:
                                    if '=' in line:
                                        key, value = line.split('=', 1)
                                        current_data[key] = value
                                    elif line == 'progress=end':
                                        # Extraction finished
                                        with jobs_lock:
                                            if job_id in jobs:
                                                jobs[job_id]['progress'] = 100
                                                jobs[job_id]['status'] = 'completing'
                                                jobs[job_id]['message'] = 'Finalizing frame extraction...'
                                        break
                                
                                # Update progress based on current frame
                                if 'frame' in current_data and current_data['frame'].isdigit():
                                    current_frame = int(current_data['frame'])
                                    progress = min(95, (current_frame / total_frames) * 100) if total_frames > 0 else 0
                                    
                                    # Get speed info
                                    speed = current_data.get('speed', 'N/A')
                                    
                                    with jobs_lock:
                                        if job_id in jobs:
                                            jobs[job_id]['progress'] = progress
                                            jobs[job_id]['extracted_frames'] = current_frame
                                            jobs[job_id]['speed'] = speed
                                            jobs[job_id]['message'] = f'Extracted {current_frame}/{total_frames} frames'
                                    
                                    print(f"Frame extraction progress: {progress:.1f}% ({current_frame}/{total_frames} frames) Speed: {speed}")
                        
                        time.sleep(0.5)  # Check every 500ms
                        
                    except Exception as e:
                        print(f"Error monitoring frame extraction progress: {e}")
                        break
            
            # Start progress monitoring thread
            progress_thread = threading.Thread(target=monitor_progress)
            progress_thread.daemon = True
            progress_thread.start()
            
            # Wait for FFmpeg to complete
            stdout, stderr = process.communicate()
            
            # Wait for progress thread to finish
            progress_thread.join(timeout=2)
            
            if process.returncode != 0:
                raise subprocess.CalledProcessError(process.returncode, cmd, stderr)
            
            # Count extracted frames
            frame_files = sorted([f for f in os.listdir(video_frames_folder) if f.startswith('frame_')])
            frames_info = []
            
            for i, filename in enumerate(frame_files):
                frames_info.append({
                    'index': i,
                    'filename': filename,
                    'path': os.path.join(video_frames_folder, filename)
                })
            
            # Update job status to completed
            with jobs_lock:
                if job_id in jobs:
                    jobs[job_id]['status'] = 'completed'
                    jobs[job_id]['progress'] = 100
                    jobs[job_id]['message'] = f'Successfully extracted {len(frame_files)} frames'
                    jobs[job_id]['frames_info'] = frames_info
                    jobs[job_id]['total'] = len(frame_files)
            
            print(f"Extracted {len(frame_files)} frames for {video_name}")
            
        finally:
            # Clean up temporary progress file
            try:
                os.unlink(progress_path)
            except:
                pass
                
    except subprocess.CalledProcessError as e:
        error_msg = e.stderr
        print(f"FFmpeg error during frame extraction: {error_msg}")
        
        with jobs_lock:
            if job_id in jobs:
                jobs[job_id]['status'] = 'error'
                jobs[job_id]['error'] = f'FFmpeg error: {error_msg}'
                
    except Exception as e:
        print(f"Frame extraction error: {str(e)}")
        with jobs_lock:
            if job_id in jobs:
                jobs[job_id]['status'] = 'error'
                jobs[job_id]['error'] = f'Extraction error: {str(e)}'

@app.route('/extraction_progress/<job_id>')
def get_extraction_progress(job_id):
    """Get progress of frame extraction job"""
    with jobs_lock:
        if job_id in jobs:
            job = jobs[job_id].copy()
            return jsonify(job)
        else:
            return jsonify({'error': 'Job not found'}), 404

@app.route('/force_extract_frames/<video_name>')
def force_extract_frames(video_name):
    video_path = os.path.join(UPLOAD_FOLDER, video_name)
    video_frames_folder = os.path.join(FRAMES_FOLDER, video_name.split('.')[0])
    
    # Remove existing frames folder to force re-extraction
    if os.path.exists(video_frames_folder):
        import shutil
        shutil.rmtree(video_frames_folder)
        print(f"Removed existing frames folder for {video_name}")
    
    # Now extract frames fresh
    return extract_frames(video_name)

@app.route('/get_frame/<video_name>/<int:frame_index>')
def get_frame(video_name, frame_index):
    video_frames_folder = os.path.join(FRAMES_FOLDER, video_name.split('.')[0])
    
    # FFmpeg starts numbering from 1, so add 1 to the frame index
    ffmpeg_frame_number = frame_index + 1
    frame_filename = f'frame_{ffmpeg_frame_number:06d}.jpg'
    frame_path = os.path.join(video_frames_folder, frame_filename)
    
    print(f"Looking for frame: {frame_path}")
    
    if os.path.exists(frame_path):
        return send_file(frame_path)
    return "Frame not found", 404

def apply_gaussian_blur(image, blur_radius=1):
    """Apply Gaussian blur effect to an image region"""
    return image.filter(ImageFilter.GaussianBlur(radius=blur_radius))


def process_frame_with_blur(frame_info):
    """Process a single frame with blur effect using CPU only"""
    import time
    start_time = time.time()
    
    original_frame_path, blurred_frame_path, frame_index, precomputed_rectangles, blur_radius = frame_info
    
    # Get precomputed active rectangles for this frame
    active_rectangles = precomputed_rectangles.get(frame_index, {})
    
    # Log frame processing details
    if frame_index % 50 == 0 or len(active_rectangles) > 0:
        rectangle_ids = list(active_rectangles.keys())
        if len(active_rectangles) > 0:
            rect_details = []
            for rect_id, rect_data in active_rectangles.items():
                rect_details.append(f"{rect_id}:({rect_data.get('x', 'N/A')},{rect_data.get('y', 'N/A')},{rect_data.get('width', 'N/A')},{rect_data.get('height', 'N/A')})")
            print(f"Processing frame {frame_index}: {len(active_rectangles)} rectangles [{', '.join(rect_details)}]")
        else:
            print(f"Processing frame {frame_index}: {len(active_rectangles)} rectangles")
    
    # Apply blur to this frame if there are active rectangles
    if active_rectangles:
        # Open the original image
        image = Image.open(original_frame_path)
        
        # Apply blur to each rectangle region
        for rect_id, rect in active_rectangles.items():
            if 'x' in rect and 'y' in rect and 'width' in rect and 'height' in rect:
                x, y, width, height = rect['x'], rect['y'], rect['width'], rect['height']
                
                # Ensure coordinates are within image bounds
                img_width, img_height = image.size
                x = max(0, min(x, img_width))
                y = max(0, min(y, img_height))
                width = min(width, img_width - x)
                height = min(height, img_height - y)
                
                if width > 0 and height > 0:
                    # Extract the region inside the rectangle
                    region = image.crop((x, y, x + width, y + height))
                    
                    # Apply blur to the region
                    blurred_region = apply_gaussian_blur(region, blur_radius=blur_radius)
                    
                    # Paste the blurred region back onto the image
                    image.paste(blurred_region, (x, y))
        
        # Save the blurred image
        image.save(blurred_frame_path)
        image.close()  # Explicitly close to free memory
    else:
        # No active rectangles, just copy the original frame
        shutil.copy2(original_frame_path, blurred_frame_path)
    
    total_time = time.time() - start_time
    if frame_index % 50 == 0 or total_time > 0.5:
        print(f"Frame {frame_index} processing time: {total_time:.3f}s")
    
    return frame_index

def process_frames_multithreaded(frame_tasks, job_id, max_workers=4):
    """Process frames using multithreading with progress tracking"""
    total_frames = len(frame_tasks)
    processed_frames = 0
    
    # Update job progress
    with jobs_lock:
        if job_id in jobs:
            jobs[job_id]['progress'] = 0
            jobs[job_id]['status'] = 'processing_frames'
            jobs[job_id]['total_frames'] = total_frames
            jobs[job_id]['processed_frames'] = 0
    
    print(f"Starting multithreaded frame processing with {max_workers} workers for {total_frames} frames...")
    processing_start_time = time.time()
    
    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        # Submit all tasks
        future_to_frame = {executor.submit(process_frame_with_blur, task): task for task in frame_tasks}
        
        # Process completed tasks
        for future in as_completed(future_to_frame):
            # Check if job was cancelled
            with jobs_lock:
                if job_id in jobs and jobs[job_id]['cancelled']:
                    print(f"Job {job_id} was cancelled, stopping frame processing")
                    # Cancel remaining futures
                    for f in future_to_frame:
                        f.cancel()
                    return False
            
            try:
                frame_index = future.result()
                processed_frames += 1
                
                # Update progress
                progress_percent = (processed_frames / total_frames) * 100
                with jobs_lock:
                    if job_id in jobs:
                        jobs[job_id]['progress'] = progress_percent
                        jobs[job_id]['processed_frames'] = processed_frames
                
                # Log progress every 10 frames
                if processed_frames % 10 == 0 or processed_frames == total_frames:
                    elapsed = time.time() - processing_start_time
                    fps = processed_frames / elapsed if elapsed > 0 else 0
                    print(f"Processed {processed_frames}/{total_frames} frames ({progress_percent:.1f}%) | FPS: {fps:.2f}")
                    
            except Exception as e:
                print(f"Error processing frame: {e}")
                with jobs_lock:
                    if job_id in jobs:
                        jobs[job_id]['error'] = str(e)
                        jobs[job_id]['status'] = 'error'
                return False
    
    print(f"Completed processing {processed_frames} frames in {time.time() - processing_start_time:.2f}s")
    return True

def run_ffmpeg_with_progress(cmd, job_id, total_frames, fps):
    """Run FFmpeg command with real-time progress monitoring"""
    
    # Create a temporary file for progress output
    with tempfile.NamedTemporaryFile(mode='w+', delete=False, suffix='.txt') as progress_file:
        progress_path = progress_file.name
    
    try:
        # Add progress monitoring to FFmpeg command
        cmd_with_progress = cmd.copy()
        # Insert progress parameters before the output file
        output_file = cmd_with_progress.pop()  # Remove output file
        cmd_with_progress.extend(['-progress', progress_path, '-stats_period', '0.5'])
        cmd_with_progress.append(output_file)  # Add output file back
        
        print(f"Executing FFmpeg with progress: {' '.join(cmd_with_progress)}")
        
        # Start FFmpeg process
        process = subprocess.Popen(
            cmd_with_progress,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,
            universal_newlines=True
        )
        
        # Monitor progress in a separate thread
        def monitor_progress():
            last_pos = 0
            while process.poll() is None:
                try:
                    with open(progress_path, 'r') as f:
                        f.seek(last_pos)
                        content = f.read()
                        last_pos = f.tell()
                        
                        if content:
                            # Parse FFmpeg progress output
                            lines = content.strip().split('\n')
                            current_data = {}
                            
                            for line in lines:
                                if '=' in line:
                                    key, value = line.split('=', 1)
                                    current_data[key] = value
                                elif line == 'progress=end':
                                    # Encoding finished
                                    with jobs_lock:
                                        if job_id in jobs:
                                            jobs[job_id]['encoding_progress'] = 100
                                            jobs[job_id]['progress'] = 98
                                    break
                            
                            # Update progress based on current frame
                            if 'frame' in current_data and current_data['frame'].isdigit():
                                current_frame = int(current_data['frame'])
                                encoding_progress = min(100, (current_frame / total_frames) * 100)
                                
                                # Get additional info
                                speed = current_data.get('speed', 'N/A')
                                bitrate = current_data.get('bitrate', 'N/A')
                                
                                with jobs_lock:
                                    if job_id in jobs and not jobs[job_id]['cancelled']:
                                        jobs[job_id]['encoding_progress'] = encoding_progress
                                        jobs[job_id]['encoding_frame'] = current_frame
                                        jobs[job_id]['encoding_speed'] = speed
                                        jobs[job_id]['encoding_bitrate'] = bitrate
                                        # Overall progress: 80% for frame processing + 18% for encoding
                                        jobs[job_id]['progress'] = 80 + (encoding_progress * 0.18)
                                
                                print(f"Encoding progress: {encoding_progress:.1f}% ({current_frame}/{total_frames} frames) Speed: {speed}")
                    
                    time.sleep(0.5)  # Check every 500ms
                    
                except Exception as e:
                    print(f"Error monitoring FFmpeg progress: {e}")
                    break
        
        # Start progress monitoring thread
        progress_thread = threading.Thread(target=monitor_progress)
        progress_thread.daemon = True
        progress_thread.start()
        
        # Wait for FFmpeg to complete
        stdout, stderr = process.communicate()
        
        # Wait for progress thread to finish
        progress_thread.join(timeout=2)
        
        if process.returncode != 0:
            raise subprocess.CalledProcessError(process.returncode, cmd_with_progress, stderr)
        
        return stdout, stderr
        
    finally:
        # Clean up temporary progress file
        try:
            os.unlink(progress_path)
        except:
            pass

def export_blurred_async(job_id, data):
    """Asynchronous export function that runs in a separate thread"""
    try:
        video_name = data['video_name']
        blur_radius = data.get('blur_radius', 5)
        video_codec = data.get('video_codec', 'libx264')
        
        with jobs_lock:
            if job_id not in jobs:
                return
            jobs[job_id]['status'] = 'initializing'
        
        # Try multiple ways to get the frames data
        frames_data = None
        
        # First check if we have direct frames array
        if 'frames' in data:
            frames_data = data['frames']
            print("Found frames data directly in request")
        # Check if it's wrapped in all_frame_rectangles
        elif 'all_frame_rectangles' in data:
            all_frame_rectangles = data['all_frame_rectangles']
            if isinstance(all_frame_rectangles, dict) and 'frames' in all_frame_rectangles:
                frames_data = all_frame_rectangles['frames']
                print("Found frames data in all_frame_rectangles.frames")
            elif isinstance(all_frame_rectangles, list):
                # Maybe it's already a list of frame events
                frames_data = all_frame_rectangles
                print("all_frame_rectangles is already a list")
        
        original_video_path = os.path.join(UPLOAD_FOLDER, video_name)
        video_frames_folder = os.path.join(FRAMES_FOLDER, video_name.split('.')[0])
        export_video_name = f'blurred_{video_name}'
        export_video_path = os.path.join(EXPORT_FOLDER, export_video_name)
        
        # Performance monitoring
        export_start_time = time.time()
        process = psutil.Process()
        initial_memory = process.memory_info().rss / 1024 / 1024  # MB
        print(f"Starting export - Initial memory usage: {initial_memory:.2f} MB")
        
        # Create blurred frames for all frames that have rectangles
        blurred_frames_folder = os.path.join(FRAMES_FOLDER, f"{video_name.split('.')[0]}_blurred")
        os.makedirs(blurred_frames_folder, exist_ok=True)
        
        # First, copy all original frames to the blurred folder
        frame_files = sorted([f for f in os.listdir(video_frames_folder) if f.startswith('frame_')])
        
        # Get the total number of frames
        total_frames = len(frame_files)
        
        # Get the maximum frame number
        max_frame = max([int(f.split('_')[1].split('.')[0]) for f in frame_files]) - 1
        
        # Check if we have frames data or need to handle legacy format
        if not frames_data:
            # Try legacy format
            if 'all_frame_rectangles' in data and isinstance(data['all_frame_rectangles'], dict):
                all_frame_rectangles = data['all_frame_rectangles']
                # Skip if it's wrapped frames data
                if 'frames' not in all_frame_rectangles:
                    print("Processing legacy rectangle format (complete states per frame)...")
                    
                    # Process legacy format - each frame has complete rectangle state
                    precomputed_rectangles = {}
                    
                    for frame_index, rectangles in all_frame_rectangles.items():
                        frame_num = int(frame_index)
                        active_rects = {}
                        
                        for i, rect in enumerate(rectangles):
                            # Skip removal markers
                            if rect.get('isRemovalMarker', False):
                                continue
                            
                            # Skip if coordinates are missing
                            if not all(key in rect for key in ['x', 'y', 'width', 'height']):
                                continue
                            
                            # Use a simple ID for this rectangle
                            rect_id = f"rect_{i}"
                            active_rects[rect_id] = {
                                'x': rect['x'],
                                'y': rect['y'],
                                'width': rect['width'],
                                'height': rect['height']
                            }
                        
                        # Store active rectangles for this frame
                        if active_rects:
                            precomputed_rectangles[frame_num] = active_rects
                    
                    frames_with_rects = len(precomputed_rectangles)
                    max_active = max((len(rects) for rects in precomputed_rectangles.values()), default=0)
                    
                    print(f"Legacy format processed: {frames_with_rects} frames with rectangles")
                    print(f"Maximum active rectangles at once: {max_active}")
                    
                    # Skip event processing and jump to frame processing
                    frames_data = None
            
            if not frames_data and 'precomputed_rectangles' not in locals():
                return jsonify({'error': 'No rectangle data provided. Please load rectangle data from a JSON file.'}), 400
        
        if frames_data:
            print(f"Processing {len(frames_data)} frames with events...")
        
        # Only process events if we have frames_data
        if frames_data:
            # Process events to track rectangle lifecycle
            print("Processing rectangle events...")
            active_rectangles = {}  # Currently active rectangles by rectangleId
            
            # Sort frames by frame number
            frames_data.sort(key=lambda x: x['frame_number'])
            
            # Precompute active rectangles for each frame
            precomputed_rectangles = {}
            
            # Process events
            frame_idx = 0
            event_count = 0
            
            for frame_data in frames_data:
                frame_num = frame_data['frame_number']
                
                # Fill frames between last processed and current frame
                while frame_idx < frame_num:
                    if active_rectangles:
                        precomputed_rectangles[frame_idx] = active_rectangles.copy()
                    frame_idx += 1
                
                # Process events at this frame
                for event in frame_data['events']:
                    event_count += 1
                    event_type = event['eventType']
                    rect_id = event.get('rectangleId')
                    
                    if event_type == 'rectangleCreated':
                        # Create new rectangle
                        if all(key in event for key in ['x', 'y', 'width', 'height']):
                            active_rectangles[rect_id] = {
                                'x': event['x'],
                                'y': event['y'],
                                'width': event['width'],
                                'height': event['height']
                            }
                            print(f"Frame {frame_num}: Created rectangle {rect_id}")
                        else:
                            print(f"Frame {frame_num}: ERROR - rectangleCreated event missing coordinates")
                    
                    elif event_type == 'rectangleMoved':
                        # Move existing rectangle
                        if rect_id in active_rectangles:
                            if all(key in event for key in ['x', 'y', 'width', 'height']):
                                active_rectangles[rect_id] = {
                                    'x': event['x'],
                                    'y': event['y'],
                                    'width': event['width'],
                                    'height': event['height']
                                }
                                print(f"Frame {frame_num}: Moved rectangle {rect_id}")
                            else:
                                print(f"Frame {frame_num}: ERROR - rectangleMoved event missing coordinates")
                        else:
                            print(f"Frame {frame_num}: WARNING - Trying to move non-existent rectangle {rect_id}")
                    
                    elif event_type == 'rectangleDeleted':
                        # Delete rectangle
                        if rect_id in active_rectangles:
                            del active_rectangles[rect_id]
                            print(f"Frame {frame_num}: Deleted rectangle {rect_id}")
                        else:
                            print(f"Frame {frame_num}: WARNING - Trying to delete non-existent rectangle {rect_id}")
                
                # Store state after processing events
                if active_rectangles:
                    precomputed_rectangles[frame_idx] = active_rectangles.copy()
                    # Log the active rectangleIds for this frame
                    rectangle_ids = list(active_rectangles.keys())
                    print(f"Frame {frame_num} final state: {len(active_rectangles)} active rectangles - IDs: {rectangle_ids}")
                
                frame_idx = frame_num + 1
            
            # Fill remaining frames
            while frame_idx <= max_frame:
                if active_rectangles:
                    precomputed_rectangles[frame_idx] = active_rectangles.copy()
                frame_idx += 1
            
            # Log statistics about rectangles
            frames_with_rects = len(precomputed_rectangles)
            unique_rect_ids = set()
            for frame_data in frames_data:
                for event in frame_data['events']:
                    if event['eventType'] == 'rectangleCreated':
                        unique_rect_ids.add(event['rectangleId'])
            
            max_active = max((len(rects) for rects in precomputed_rectangles.values()), default=0)
            
            print(f"\nRectangle processing complete:")
            print(f"Total events processed: {event_count}")
            print(f"Total unique rectangles: {len(unique_rect_ids)}")
            print(f"Unique rectangleIds processed: {sorted(unique_rect_ids)}")
            print(f"Frames with active rectangles: {frames_with_rects}/{max_frame + 1}")
            print(f"Maximum active rectangles at once: {max_active}")
            
            # Log a sample of frames with their active rectangles for debugging
            sample_frames = sorted(list(precomputed_rectangles.keys()))[:10]  # Show first 10 frames with rectangles
            if sample_frames:
                print(f"Sample of frames with rectangles (first 10):")
                for frame_idx in sample_frames:
                    rect_ids = list(precomputed_rectangles[frame_idx].keys())
                    print(f"  Frame {frame_idx}: {rect_ids}")
        
        # Prepare frame processing tasks
        frame_tasks = []
        for frame_file in frame_files:
            original_frame_path = os.path.join(video_frames_folder, frame_file)
            blurred_frame_path = os.path.join(blurred_frames_folder, frame_file)
            
            # Extract frame index from filename (FFmpeg starts from 1, but UI uses 0-based)
            ffmpeg_frame_number = int(frame_file.split('_')[1].split('.')[0])
            ui_frame_index = ffmpeg_frame_number - 1  # Convert to 0-based indexing for UI
            
            frame_tasks.append((original_frame_path, blurred_frame_path, ui_frame_index, precomputed_rectangles, blur_radius))
        
        # Process frames with multithreading and progress tracking
        processing_start_time = time.time()
        
        # Check if job was cancelled before starting
        with jobs_lock:
            if job_id in jobs and jobs[job_id]['cancelled']:
                print(f"Job {job_id} was cancelled before frame processing")
                return
        
        # Process frames using multithreading
        success = process_frames_multithreaded(frame_tasks, job_id, max_workers=4)
        
        if not success:
            with jobs_lock:
                if job_id in jobs:
                    if jobs[job_id]['cancelled']:
                        jobs[job_id]['status'] = 'cancelled'
                        jobs[job_id]['message'] = 'Export cancelled by user'
                    else:
                        jobs[job_id]['status'] = 'error'
                        jobs[job_id]['message'] = 'Error during frame processing'
            return
        
        # Get original video properties
        cmd = [
            'ffprobe', '-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', original_video_path
        ]
        result = subprocess.run(cmd, capture_output=True, text=True, check=True)
        info = json.loads(result.stdout)
        
        video_stream = next((s for s in info['streams'] if s['codec_type'] == 'video'), None)
        audio_stream = next((s for s in info['streams'] if s['codec_type'] == 'audio'), None)
        
        if not video_stream:
            return jsonify({'error': 'No video stream found'}), 400
        
        # Build FFmpeg command to recreate video with same settings
        frame_pattern = os.path.join(blurred_frames_folder, 'frame_%06d.jpg')
        
        cmd = [
            'ffmpeg', '-y',  # Overwrite output file
            '-framerate', str(eval(video_stream['r_frame_rate'])),  # Use original framerate
            '-i', frame_pattern,  # Input frame pattern
        ]
        
        # Add audio if it exists
        if audio_stream:
            print(f"Found audio stream: {audio_stream.get('codec_name', 'unknown')} - copying to output")
            cmd.extend(['-i', original_video_path])  # Add original video as audio source
            cmd.extend(['-c:a', 'copy'])  # Copy audio codec (no re-encoding)
            cmd.extend(['-map', '0:v:0', '-map', '1:a:0'])  # Map video from frames, audio from original
        else:
            print("No audio stream found in original video")
        
        # Video encoding settings - use selected codec
        cmd.extend([
            '-c:v', video_codec,  # Use selected codec
            '-pix_fmt', video_stream.get('pix_fmt', 'yuv420p'),  # Use original pixel format
        ])
        
        # Add bitrate if available
        if 'bit_rate' in video_stream:
            cmd.extend(['-b:v', video_stream['bit_rate']])
        
        cmd.append(export_video_path)
        
        # Update job status for FFmpeg encoding
        with jobs_lock:
            if job_id in jobs:
                jobs[job_id]['status'] = 'encoding'
                jobs[job_id]['progress'] = 80
                jobs[job_id]['encoding_progress'] = 0
        
        # Execute FFmpeg command with progress monitoring
        ffmpeg_start_time = time.time()
        stdout, stderr = run_ffmpeg_with_progress(cmd, job_id, total_frames, eval(video_stream['r_frame_rate']))
        ffmpeg_time = time.time() - ffmpeg_start_time
        print(f"FFmpeg export completed in {ffmpeg_time:.2f}s")
        
        # Final performance report
        total_export_time = time.time() - export_start_time
        final_memory = process.memory_info().rss / 1024 / 1024  # MB
        
        print("\n=== EXPORT PERFORMANCE SUMMARY ===")
        print(f"Total export time: {total_export_time:.2f}s")
        print(f"Frame processing time: {time.time() - processing_start_time - ffmpeg_time:.2f}s")
        print(f"FFmpeg encoding time: {ffmpeg_time:.2f}s")
        print(f"Memory usage: Initial={initial_memory:.2f}MB, Final={final_memory:.2f}MB, Peak increase={final_memory - initial_memory:.2f}MB")
        print("=================================\n")
        
        # Build success message
        audio_info = " (with audio)" if audio_stream else " (video only - no audio in original)"
        success_message = f'Video exported with blur effect{audio_info}: {export_video_name}'
        
        # Update job status to completed
        with jobs_lock:
            if job_id in jobs:
                jobs[job_id]['status'] = 'completed'
                jobs[job_id]['progress'] = 100
                jobs[job_id]['export_path'] = export_video_path
                jobs[job_id]['filename'] = export_video_name
                jobs[job_id]['message'] = success_message
                jobs[job_id]['has_audio'] = bool(audio_stream)
                jobs[job_id]['total_time'] = total_export_time
        
    except subprocess.CalledProcessError as e:
        error_msg = e.stderr
        print(f"FFmpeg error: {error_msg}")
        
        with jobs_lock:
            if job_id in jobs:
                jobs[job_id]['status'] = 'error'
                jobs[job_id]['error'] = f'FFmpeg error: {error_msg}'
        
        # If there's an audio-related error, try without audio
        if audio_stream and ('audio' in error_msg.lower() or 'stream' in error_msg.lower()):
            print("Retrying export without audio due to audio stream error...")
            try:
                # Retry without audio
                cmd_no_audio = [
                    'ffmpeg', '-y',
                    '-framerate', str(eval(video_stream['r_frame_rate'])),
                    '-i', frame_pattern,
                    '-c:v', video_codec,  # Use selected codec
                    '-pix_fmt', video_stream.get('pix_fmt', 'yuv420p'),
                ]
                
                if 'bit_rate' in video_stream:
                    cmd_no_audio.extend(['-b:v', video_stream['bit_rate']])
                
                cmd_no_audio.append(export_video_path)
                
                stdout, stderr = run_ffmpeg_with_progress(cmd_no_audio, job_id, total_frames, eval(video_stream['r_frame_rate']))
                
                with jobs_lock:
                    if job_id in jobs:
                        jobs[job_id]['status'] = 'completed'
                        jobs[job_id]['progress'] = 100
                        jobs[job_id]['export_path'] = export_video_path
                        jobs[job_id]['filename'] = export_video_name
                        jobs[job_id]['message'] = f'Video exported with blur effect (audio excluded): {export_video_name}'
                        jobs[job_id]['has_audio'] = False
                        jobs[job_id]['warning'] = 'Audio could not be copied due to compatibility issues'
                
            except subprocess.CalledProcessError as retry_error:
                with jobs_lock:
                    if job_id in jobs:
                        jobs[job_id]['status'] = 'error'
                        jobs[job_id]['error'] = f'FFmpeg error (retry failed): {retry_error.stderr}'
        
    except Exception as e:
        print(f"Export error: {str(e)}")
        with jobs_lock:
            if job_id in jobs:
                jobs[job_id]['status'] = 'error'
                jobs[job_id]['error'] = f'Export error: {str(e)}'

@app.route('/export_blurred', methods=['POST'])
def export_blurred():
    """Start an asynchronous export job"""
    data = request.json
    
    # Generate unique job ID
    job_id = str(uuid.uuid4())
    
    # Initialize job tracking
    with jobs_lock:
        jobs[job_id] = {
            'id': job_id,
            'status': 'starting',
            'progress': 0,
            'message': 'Starting export...',
            'cancelled': False,
            'created_at': time.time()
        }
    
    # Start export in background thread
    thread = threading.Thread(target=export_blurred_async, args=(job_id, data))
    thread.daemon = True
    thread.start()
    
    return jsonify({'job_id': job_id, 'message': 'Export started'})

def preview_blurred_async(job_id, data):
    """Asynchronous preview function that runs in a separate thread"""
    try:
        video_name = data['video_name']
        blur_radius = data.get('blur_radius', 5)
        video_codec = data.get('video_codec', 'libx264')
        start_frame = data.get('start_frame', 0)
        end_frame = data.get('end_frame', 199)
        
        # Limit preview to 200 frames max
        if end_frame - start_frame > 199:
            end_frame = start_frame + 199
        
        with jobs_lock:
            if job_id not in jobs:
                return
            jobs[job_id]['status'] = 'initializing'
        
        print(f"Creating preview from frame {start_frame} to {end_frame} ({end_frame - start_frame + 1} frames)")
        
        # Get frames data
        frames_data = data.get('frames', [])
        
        original_video_path = os.path.join(UPLOAD_FOLDER, video_name)
        video_frames_folder = os.path.join(FRAMES_FOLDER, video_name.split('.')[0])
        preview_video_name = f'preview_{video_name.split(".")[0]}_f{start_frame}-{end_frame}.mp4'
        preview_video_path = os.path.join(EXPORT_FOLDER, preview_video_name)
        
        # Process frames similar to export but limited range
        blurred_frames_folder = os.path.join(FRAMES_FOLDER, f"{video_name.split('.')[0]}_preview_blurred")
        os.makedirs(blurred_frames_folder, exist_ok=True)
        
        # Get frame files in the range
        all_frame_files = sorted([f for f in os.listdir(video_frames_folder) if f.startswith('frame_')])
        
        # Convert frame indices to 1-based FFmpeg numbering for file lookup
        preview_frame_files = []
        for i in range(start_frame, end_frame + 1):
            ffmpeg_frame_number = i + 1  # Convert to 1-based indexing
            frame_filename = f'frame_{ffmpeg_frame_number:06d}.jpg'
            if frame_filename in all_frame_files:
                preview_frame_files.append(frame_filename)
        
        print(f"Processing {len(preview_frame_files)} preview frames")
        
        # Process events similar to full export
        active_rectangles = {}
        frames_data.sort(key=lambda x: x['frame_number'])
        
        # Precompute active rectangles for each frame in preview range
        precomputed_rectangles = {}
        
        # Process events
        frame_idx = 0
        for frame_data in frames_data:
            frame_num = frame_data['frame_number']
            
            # Fill frames between last processed and current frame
            while frame_idx < frame_num:
                if frame_idx >= start_frame and frame_idx <= end_frame and active_rectangles:
                    precomputed_rectangles[frame_idx] = active_rectangles.copy()
                frame_idx += 1
            
            # Process events at this frame
            for event in frame_data['events']:
                event_type = event['eventType']
                rect_id = event.get('rectangleId')
                
                if event_type == 'rectangleCreated':
                    if all(key in event for key in ['x', 'y', 'width', 'height']):
                        active_rectangles[rect_id] = {
                            'x': event['x'],
                            'y': event['y'],
                            'width': event['width'],
                            'height': event['height']
                        }
                
                elif event_type == 'rectangleMoved':
                    if rect_id in active_rectangles:
                        if all(key in event for key in ['x', 'y', 'width', 'height']):
                            active_rectangles[rect_id] = {
                                'x': event['x'],
                                'y': event['y'],
                                'width': event['width'],
                                'height': event['height']
                            }
                
                elif event_type == 'rectangleDeleted':
                    if rect_id in active_rectangles:
                        del active_rectangles[rect_id]
            
            # Store state after processing events (only for preview range)
            if frame_num >= start_frame and frame_num <= end_frame and active_rectangles:
                precomputed_rectangles[frame_idx] = active_rectangles.copy()
            
            frame_idx = frame_num + 1
        
        # Fill remaining frames in preview range
        while frame_idx <= end_frame:
            if frame_idx >= start_frame and active_rectangles:
                precomputed_rectangles[frame_idx] = active_rectangles.copy()
            frame_idx += 1
        
        # Prepare frame processing tasks
        frame_tasks = []
        for frame_file in preview_frame_files:
            original_frame_path = os.path.join(video_frames_folder, frame_file)
            blurred_frame_path = os.path.join(blurred_frames_folder, frame_file)
            
            # Extract frame index from filename
            ffmpeg_frame_number = int(frame_file.split('_')[1].split('.')[0])
            ui_frame_index = ffmpeg_frame_number - 1
            
            # Only process if in range
            if ui_frame_index >= start_frame and ui_frame_index <= end_frame:
                frame_tasks.append((original_frame_path, blurred_frame_path, ui_frame_index, precomputed_rectangles, blur_radius))
        
        # Process frames with multithreading
        success = process_frames_multithreaded(frame_tasks, job_id, max_workers=4)
        
        if not success:
            with jobs_lock:
                if job_id in jobs:
                    if jobs[job_id]['cancelled']:
                        jobs[job_id]['status'] = 'cancelled'
                        jobs[job_id]['message'] = 'Preview cancelled by user'
                    else:
                        jobs[job_id]['status'] = 'error'
                        jobs[job_id]['message'] = 'Error during frame processing'
            return
        
        # Get video properties
        cmd = [
            'ffprobe', '-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', original_video_path
        ]
        result = subprocess.run(cmd, capture_output=True, text=True, check=True)
        info = json.loads(result.stdout)
        
        video_stream = next((s for s in info['streams'] if s['codec_type'] == 'video'), None)
        audio_stream = next((s for s in info['streams'] if s['codec_type'] == 'audio'), None)
        
        if not video_stream:
            return jsonify({'error': 'No video stream found'}), 400
        
        # Build FFmpeg command for preview
        frame_pattern = os.path.join(blurred_frames_folder, 'frame_%06d.jpg')
        
        cmd = [
            'ffmpeg', '-y',
            '-framerate', str(eval(video_stream['r_frame_rate'])),
            '-start_number', str(start_frame + 1),  # Start from the first preview frame
            '-i', frame_pattern,
        ]
        
        # Add audio if it exists (extract only the preview portion)
        if audio_stream:
            start_time = start_frame / eval(video_stream['r_frame_rate'])
            duration = (end_frame - start_frame + 1) / eval(video_stream['r_frame_rate'])
            cmd.extend(['-ss', str(start_time), '-t', str(duration), '-i', original_video_path])
            cmd.extend(['-c:a', 'copy'])
            cmd.extend(['-map', '0:v:0', '-map', '1:a:0'])
        
        # Video encoding settings
        cmd.extend([
            '-c:v', video_codec,
            '-pix_fmt', video_stream.get('pix_fmt', 'yuv420p'),
        ])
        
        # Limit frames for preview
        cmd.extend(['-frames:v', str(len(preview_frame_files))])
        
        cmd.append(preview_video_path)
        
        # Update job status for FFmpeg encoding
        with jobs_lock:
            if job_id in jobs:
                jobs[job_id]['status'] = 'encoding'
                jobs[job_id]['progress'] = 80
                jobs[job_id]['encoding_progress'] = 0
        
        # Execute FFmpeg command with progress monitoring
        print(f"Executing preview FFmpeg command: {' '.join(cmd)}")
        preview_frames = len(frame_tasks)
        stdout, stderr = run_ffmpeg_with_progress(cmd, job_id, preview_frames, eval(video_stream['r_frame_rate']))
        
        # Update job status to completed
        with jobs_lock:
            if job_id in jobs:
                jobs[job_id]['status'] = 'completed'
                jobs[job_id]['progress'] = 100
                jobs[job_id]['export_path'] = preview_video_path
                jobs[job_id]['filename'] = preview_video_name
                jobs[job_id]['message'] = f'Preview created with {len(frame_tasks)} frames'
                jobs[job_id]['has_audio'] = bool(audio_stream)
                jobs[job_id]['start_frame'] = start_frame
                jobs[job_id]['end_frame'] = end_frame
                jobs[job_id]['frame_count'] = len(frame_tasks)
        
    except subprocess.CalledProcessError as e:
        print(f"FFmpeg error during preview: {e.stderr}")
        with jobs_lock:
            if job_id in jobs:
                jobs[job_id]['status'] = 'error'
                jobs[job_id]['error'] = f'FFmpeg error during preview: {e.stderr}'
    except Exception as e:
        print(f"Preview error: {str(e)}")
        with jobs_lock:
            if job_id in jobs:
                jobs[job_id]['status'] = 'error'
                jobs[job_id]['error'] = f'Preview error: {str(e)}'

@app.route('/preview_blurred', methods=['POST'])
def preview_blurred():
    """Start an asynchronous preview job"""
    data = request.json
    
    # Generate unique job ID
    job_id = str(uuid.uuid4())
    
    # Initialize job tracking
    with jobs_lock:
        jobs[job_id] = {
            'id': job_id,
            'status': 'starting',
            'progress': 0,
            'message': 'Starting preview...',
            'cancelled': False,
            'created_at': time.time()
        }
    
    # Start preview in background thread
    thread = threading.Thread(target=preview_blurred_async, args=(job_id, data))
    thread.daemon = True
    thread.start()
    
    return jsonify({'job_id': job_id, 'message': 'Preview started'})

@app.route('/export_progress/<job_id>')
def get_export_progress(job_id):
    """Get progress of an export job"""
    with jobs_lock:
        if job_id in jobs:
            job = jobs[job_id].copy()
            return jsonify(job)
        else:
            return jsonify({'error': 'Job not found'}), 404

@app.route('/cancel_export/<job_id>', methods=['POST'])
def cancel_export(job_id):
    """Cancel an export job"""
    with jobs_lock:
        if job_id in jobs:
            jobs[job_id]['cancelled'] = True
            jobs[job_id]['status'] = 'cancelled'
            print(f"Job {job_id} marked for cancellation")
            return jsonify({'success': True, 'message': 'Job cancellation requested'})
        else:
            return jsonify({'error': 'Job not found'}), 404

@app.route('/save_rectangles', methods=['POST'])
def save_rectangles():
    data = request.json
    video_name = data['video_name']
    all_frame_rectangles = data.get('all_frame_rectangles', {})
    
    print(f"=== SAVE RECTANGLES DEBUG ===")
    print(f"Video name: {video_name}")
    print(f"Auto-save: {data.get('auto_save', False)}")
    print(f"Received frame rectangles: {all_frame_rectangles}")
    print(f"Number of frames with data: {len(all_frame_rectangles)}")
    
    # Create rectangles data structure with events
    rectangles_data = {
        'video_name': video_name,
        'timestamp': data.get('timestamp'),
        'frames': []
    }
    
    # Track rectangle IDs to ensure consistency
    rectangle_id_counter = 0
    
    # Convert frame rectangles to structured format with events
    for frame_index, rectangles in all_frame_rectangles.items():
        frame_data = {
            'frame_number': int(frame_index),
            'events': []
        }
        
        print(f"Frame {frame_index}: {len(rectangles)} rectangles")
        
        for i, rect in enumerate(rectangles):
            # Check if this is a removal marker
            if rect.get('isRemovalMarker', False):
                # Handle rectangleDeleted event
                event_data = {
                    'eventType': 'rectangleDeleted',
                    'rectangleId': rect.get('removesRect', None)
                }
                print(f"  Rectangle deleted: {event_data['rectangleId']}")
            elif rect.get('rectangleMoved', False):
                # Handle rectangleMoved event
                event_data = {
                    'eventType': 'rectangleMoved',
                    'rectangleId': rect.get('rectangleMoved'),
                    'x': rect['x'],
                    'y': rect['y'],
                    'width': rect['width'],
                    'height': rect['height']
                }
                print(f"  Rectangle moved: {event_data['rectangleId']} to x={rect['x']}, y={rect['y']}")
            elif rect.get('rectangleResized', False):
                # Handle rectangleResized event
                event_data = {
                    'eventType': 'rectangleResized',
                    'rectangleId': rect.get('rectangleResized'),
                    'x': rect['x'],
                    'y': rect['y'],
                    'width': rect['width'],
                    'height': rect['height']
                }
                print(f"  Rectangle resized: {event_data['rectangleId']} to w={rect['width']}, h={rect['height']}")
            else:
                # Handle rectangleCreated event
                # Use the rectangleId from the rectangle data, or generate one if missing
                rect_id = rect.get('rectangleId', f"{frame_index}_{i}")
                event_data = {
                    'eventType': 'rectangleCreated',
                    'rectangleId': rect_id,
                    'x': rect['x'],
                    'y': rect['y'],
                    'width': rect['width'],
                    'height': rect['height']
                }
                print(f"  Rectangle created: {rect_id} at x={rect['x']}, y={rect['y']}")
            
            frame_data['events'].append(event_data)
        
        rectangles_data['frames'].append(frame_data)
    
    # Sort frames by frame number
    rectangles_data['frames'].sort(key=lambda x: x['frame_number'])
    
    # Save to JSON file
    filename = f"rectangles_{video_name.split('.')[0]}.json"
    filepath = os.path.join(EXPORT_FOLDER, filename)
    
    print(f"Saving to: {filepath}")
    print(f"Total frames: {len(rectangles_data['frames'])}")
    print(f"Total events: {sum(len(frame['events']) for frame in rectangles_data['frames'])}")
    print("============================")
    
    try:
        with open(filepath, 'w') as f:
            json.dump(rectangles_data, f, indent=2)
        
        return jsonify({
            'success': True,
            'filename': filename,
            'filepath': filepath,
            'total_frames': len(rectangles_data['frames']),
            'total_events': sum(len(frame['events']) for frame in rectangles_data['frames'])
        })
    
    except Exception as e:
        print(f"Save error: {str(e)}")
        return jsonify({'error': f'Failed to save rectangles: {str(e)}'}), 500

@app.route('/download_rectangles/<filename>')
def download_rectangles(filename):
    filepath = os.path.join(EXPORT_FOLDER, filename)
    if os.path.exists(filepath):
        return send_file(filepath, as_attachment=True)
    return "File not found", 404

@app.route('/load_rectangles/<video_name>')
def load_rectangles(video_name):
    """Load existing rectangle data for a video"""
    filename = f"rectangles_{video_name.split('.')[0]}.json"
    filepath = os.path.join(EXPORT_FOLDER, filename)
    
    print(f"=== LOAD RECTANGLES DEBUG ===")
    print(f"Loading for video: {video_name}")
    print(f"Looking for file: {filepath}")
    print(f"File exists: {os.path.exists(filepath)}")
    
    if os.path.exists(filepath):
        try:
            with open(filepath, 'r') as f:
                rectangles_data = json.load(f)
            
            print(f"Loaded rectangles data: {rectangles_data}")
            
            # Convert from event format back to frame rectangles format
            # Use the same logic as export processing for consistency
            frame_rectangles = {}
            active_rectangles = {}  # Currently active rectangles by rectangleId
            
            # Sort frames by frame number for chronological processing
            sorted_frames = sorted(rectangles_data.get('frames', []), key=lambda x: x['frame_number'])
            
            for frame_data in sorted_frames:
                frame_number = frame_data['frame_number']
                print(f"Frame {frame_number}: {len(frame_data['events'])} events")
                
                # Initialize frame rectangles array
                frame_rectangles[str(frame_number)] = []
                
                # Process events to create frameRectangles entries (for UI compatibility)
                for event in frame_data['events']:
                    event_type = event.get('eventType')
                    rect_id = event.get('rectangleId')
                    
                    if event_type == 'rectangleCreated':
                        # Create new rectangle
                        if all(key in event for key in ['x', 'y', 'width', 'height']):
                            active_rectangles[rect_id] = {
                                'x': event['x'],
                                'y': event['y'],
                                'width': event['width'],
                                'height': event['height']
                            }
                            # Add to frame rectangles with rectangleId
                            frame_rectangles[str(frame_number)].append({
                                'x': event['x'],
                                'y': event['y'],
                                'width': event['width'],
                                'height': event['height'],
                                'rectangleId': rect_id
                            })
                            print(f"  Rectangle created: {rect_id} at x={event['x']}, y={event['y']}")
                    
                    elif event_type == 'rectangleMoved':
                        # Move existing rectangle (update position)
                        if rect_id in active_rectangles:
                            if all(key in event for key in ['x', 'y', 'width', 'height']):
                                active_rectangles[rect_id] = {
                                    'x': event['x'],
                                    'y': event['y'],
                                    'width': event['width'],
                                    'height': event['height']
                                }
                                # Add rectangleMoved entry to frame rectangles
                                frame_rectangles[str(frame_number)].append({
                                    'rectangleMoved': rect_id,
                                    'x': event['x'],
                                    'y': event['y'],
                                    'width': event['width'],
                                    'height': event['height']
                                })
                                print(f"  Rectangle moved: {rect_id} to x={event['x']}, y={event['y']}")
                            else:
                                print(f"  ERROR - rectangleMoved event missing coordinates for {rect_id}")
                        else:
                            print(f"  WARNING - Trying to move non-existent rectangle {rect_id}")
                    
                    elif event_type == 'rectangleDeleted':
                        # Delete rectangle
                        if rect_id in active_rectangles:
                            del active_rectangles[rect_id]
                            # Add removal marker to frame rectangles
                            frame_rectangles[str(frame_number)].append({
                                'removesRect': rect_id,
                                'isRemovalMarker': True
                            })
                            print(f"  Rectangle deleted: {rect_id}")
                        else:
                            print(f"  WARNING - Trying to delete non-existent rectangle {rect_id}")
                    
                    elif event_type == 'rectangleResized':
                        # Resize existing rectangle (update dimensions)
                        if rect_id in active_rectangles:
                            if all(key in event for key in ['x', 'y', 'width', 'height']):
                                active_rectangles[rect_id] = {
                                    'x': event['x'],
                                    'y': event['y'],
                                    'width': event['width'],
                                    'height': event['height']
                                }
                                # Add rectangleResized entry to frame rectangles
                                frame_rectangles[str(frame_number)].append({
                                    'rectangleResized': rect_id,
                                    'x': event['x'],
                                    'y': event['y'],
                                    'width': event['width'],
                                    'height': event['height']
                                })
                                print(f"  Rectangle resized: {rect_id} to w={event['width']}, h={event['height']}")
                            else:
                                print(f"  ERROR - rectangleResized event missing coordinates for {rect_id}")
                        else:
                            print(f"  WARNING - Trying to resize non-existent rectangle {rect_id}")
                
                print(f"  Frame {frame_number} created with {len(frame_rectangles[str(frame_number)])} rectangle entries")
            
            print(f"Final frame_rectangles: {frame_rectangles}")
            print(f"Total frames: {len(frame_rectangles)}")
            print(f"Total rectangles: {sum(len(rects) for rects in frame_rectangles.values())}")
            print("============================")
            
            return jsonify({
                'success': True,
                'frame_rectangles': frame_rectangles,
                'total_frames': len(frame_rectangles),
                'total_rectangles': sum(len(rects) for rects in frame_rectangles.values()),
                'filename': filename
            })
            
        except Exception as e:
            print(f"Load error: {str(e)}")
            return jsonify({'error': f'Failed to load rectangles: {str(e)}'}), 500
    else:
        print("No existing rectangle data found")
        return jsonify({
            'success': True,
            'frame_rectangles': {},
            'total_frames': 0,
            'total_rectangles': 0,
            'message': 'No existing rectangle data found'
        })

if __name__ == '__main__':
    app.run(debug=True)
