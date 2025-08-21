# Video Frame Editor with Blur Effects

A web-based video editor that allows you to apply blur effects to specific regions of video frames by drawing rectangles on a timeline interface.

![Video Editor Interface](Screenshot%202025-08-19%20091344.png)

## Features

- **Video Frame Extraction**: Automatically extract frames from video files
- **Interactive Rectangle Drawing**: Draw rectangles on video frames to mark blur regions
- **Timeline Navigation**: Navigate through video frames with thumbnail timeline
- **Rectangle Management**: Create, move, resize, and delete blur rectangles
- **Property Panel**: View detailed properties of selected rectangles
- **Blur Effect Options**: Multiple blur intensity levels (Light to Extreme)
- **Video Export**: Export processed video with blur effects applied
- **Hardware Acceleration**: Automatic detection and selection of GPU encoders (NVIDIA NVENC, Intel QuickSync, AMD AMF)
- **Preview Generation**: Generate preview clips to test effects
- **Auto-save**: Automatic saving of rectangle data
- **Keyboard Shortcuts**: Quick navigation and debugging tools

## Prerequisites

Before running the application, ensure you have the following installed:

- **Python 3.7+**
- **FFmpeg** (for video processing)
- **Required Python packages** (see Installation section)

## Installation

1. **Clone or download** this repository to your local machine

2. **Create a virtual environment** (recommended):
   ```bash
   python -m venv venv
   ```

3. **Activate the virtual environment**:
   - **Windows**: `venv\Scripts\activate`
   - **macOS/Linux**: `source venv/bin/activate`

4. **Install Python dependencies**:
   ```bash
   pip install -r requirements.txt
   ```

5. **Install FFmpeg**:
   - **Windows**: Download from [https://ffmpeg.org/download.html](https://ffmpeg.org/download.html)
   - **macOS**: `brew install ffmpeg`
   - **Linux**: `sudo apt install ffmpeg` (Ubuntu/Debian) or equivalent

6. **Create required directories** (will be created automatically on first run):
   - `data/` - for uploaded video files
   - `frames/` - for extracted frame images
   - `exports/` - for exported videos and saved rectangle data

## Usage

### Starting the Application

1. **Activate the virtual environment** (if not already active):
   - **Windows**: `venv\Scripts\activate`
   - **macOS/Linux**: `source venv/bin/activate`

2. **Run the Flask application**:
   ```bash
   python app.py
   ```

3. **Open your web browser** and navigate to:
   ```
   http://localhost:5000
   ```

4. **Hardware encoder detection**: On page load, the application will:
   - Check FFmpeg installation and version
   - Scan for available hardware encoders
   - Auto-select the best codec (NVIDIA NVENC H.264 preferred)
   - Display status message with detected hardware encoders

### Loading a Video

1. **Place your video file** in the `data/` folder
   - Supported formats: `.mp4`, `.avi`, `.mov`, `.mkv`

2. **Select the video** from the dropdown menu

3. **Click "Load Video"** to extract frames and create the timeline

### Drawing Blur Rectangles

1. **Click and drag** on the video frame to draw a rectangle
2. **The rectangle ID** will appear in the top-left corner
3. **Selected rectangles** show resize handles and highlight in the property panel

### Rectangle Management

#### Selecting Rectangles
- **Click** on any rectangle to select it
- **Selected rectangles** show:
  - Resize handles on corners and edges
  - Highlighted border
  - Properties displayed in the right panel

#### Moving Rectangles
- **Click and drag** the rectangle body to move it
- Position updates automatically in the property panel

#### Resizing Rectangles
- **Click and drag** the resize handles to change dimensions
- Size updates automatically in the property panel

#### Deleting Rectangles
- **Click the × button** on a rectangle to delete it
- **Shift+Click** on a rectangle for quick deletion
- Deleted rectangles can be restored using the ↺ button

### Rectangle Inheritance Between Frames

The video editor uses an intelligent inheritance system to manage rectangles across frames:

#### How Inheritance Works
1. **Rectangle Persistence**: When you draw a rectangle on a frame, it automatically appears on all subsequent frames
2. **Keyframe System**: Each frame where you make changes (add, move, resize, or delete rectangles) becomes a "keyframe"
3. **Automatic Propagation**: Changes made on a keyframe affect all frames until the next keyframe

#### Rectangle States and Visual Indicators
Rectangles are displayed with different colors and styles to indicate their state:

- **🔴 Red Border (Solid)**: New rectangles created on the current frame
- **🔵 Blue Border (Dashed)**: Inherited rectangles from previous keyframes (unchanged)
- **🟢 Green Border**: Rectangles that were inherited and then modified on this frame
- **🟣 Purple Border**: Rectangles that were moved from their inherited position
- **🟠 Orange Border**: Rectangles that were resized from their inherited dimensions
- **⚪ Gray Border (Dashed)**: Deleted rectangles (can be restored)

#### Working with Inheritance
1. **Creating Rectangles**: Draw on any frame - the rectangle appears on all subsequent frames
2. **Modifying Inherited Rectangles**: 
   - Move or resize an inherited rectangle to create a new keyframe
   - The change affects all subsequent frames until the next keyframe
3. **Deleting Rectangles**: 
   - Delete a rectangle to remove it from the current frame and all subsequent frames
   - Use the restore button (↺) to bring back deleted rectangles
4. **Frame Navigation**: 
   - Diamond markers on the timeline show keyframes
   - Click diamonds to jump directly to frames with changes

#### Practical Example
```
Frame 1: Draw rectangle A at position (100, 100)
         → Rectangle A appears on all subsequent frames

Frame 5: Move rectangle A to position (200, 100)
         → Rectangle A moves to new position on frames 5-end
         → Frames 1-4 keep the original position (100, 100)
         → Frame 5 becomes a keyframe (diamond marker appears)

Frame 8: Draw rectangle B at position (150, 150)
         → Rectangle B appears on frames 8-end
         → Rectangle A remains at position (200, 100)
         → Frame 8 becomes a keyframe

Frame 12: Delete rectangle A
          → Rectangle A disappears from frames 12-end
          → Rectangle B continues on frames 12-end
          → Frame 12 becomes a keyframe
```

This system allows you to create complex animations and effects while maintaining full control over when and how rectangles appear, move, and disappear throughout your video.

### Property Panel

The property panel (right side) shows details for the currently selected rectangle:

- **Rectangle ID**: Unique identifier
- **X/Y Position**: Coordinates in pixels
- **Width/Height**: Dimensions in pixels
- **Effect Type**: Blur intensity level
- **Blur Intensity**: Current blur setting in pixels

### Timeline Navigation

- **Timeline Scrubber**: Drag the handle or click anywhere on the timeline to jump to specific frames
- **Diamond Keyframe Markers**: Click on diamond-shaped markers to jump to frames with rectangle changes
- **Thumbnail Navigation**: Click thumbnail images to jump to specific frames
- **Keyboard Navigation**: Use arrow keys (←/→) to navigate frame by frame
- **Navigation Buttons**:
  - "← Previous Keyframe" - Go to previous frame with rectangle changes
  - "Next Keyframe →" - Go to next frame with rectangle changes
- **Frame Counter**: Shows current frame and total frames with keyframe information

### Blur Settings

Choose blur intensity from the dropdown:
- **Light (5px)** - Subtle blur effect
- **Medium (10px)** - Moderate blur
- **Heavy (15px)** - Strong blur (default)
- **Very Heavy (20px)** - Very strong blur
- **Extreme (30px)** - Maximum blur effect

### Video Export

#### Preview Generation
1. **Click "Preview Blur (200 frames)"** to generate a short preview
2. Preview includes first 200 frames with applied effects
3. Useful for testing before full export

#### Full Export
1. **Video codec auto-selection**: The application automatically detects and selects the best available codec:
   - **NVIDIA NVENC H.264** - Highest priority (GPU acceleration, fastest)
   - **Other hardware encoders** - Intel QuickSync, AMD AMF (GPU acceleration)
   - **libx264** - Software encoding fallback (CPU, compatible with all systems)

2. **Manual codec selection**: You can override the auto-selection by choosing from the dropdown:
   - `NVIDIA NVENC H.264` - NVIDIA GPU acceleration (fastest, requires NVIDIA GPU)
   - `Intel QuickSync H.264` - Intel integrated GPU acceleration (requires Intel iGPU)
   - `AMD AMF H.264` - AMD GPU acceleration (requires AMD GPU)
   - `libx264 (Software CPU)` - Software encoding (compatible with all systems)

3. **Click "Export Video with Blur"** to start processing

3. **Monitor progress** in the export modal showing:
   - Frame processing progress
   - Encoding progress
   - Audio status

#### Export Process
The export process includes:
1. **Frame Analysis** - Processing rectangle data
2. **Blur Application** - Applying effects to marked regions
3. **Audio Copying** - Preserving original audio track
4. **Video Encoding** - Creating final output file

### Saving and Loading Rectangle Data

#### Auto-save
- Rectangle data is automatically saved as you work
- Changes are preserved between sessions

#### Manual Save
- **Click "Save Rectangle Data"** to export rectangle definitions
- Creates a JSON file in the `exports/` folder
- Includes all rectangle events and timing information

#### Loading Existing Data
- **Click "Load Rectangles"** to restore previously saved rectangle data
- Automatically loads when opening a video if data exists

### Keyboard Shortcuts

- **← / →** - Navigate between frames
- **Ctrl+N** - Go to next frame with changes
- **Ctrl+P** - Go to previous frame with changes
- **Ctrl+D** - Debug rectangle state (console output)

## File Structure

```
VideoEditor/
├── app.py                 # Main Flask application
├── README.md             # This file
├── templates/
│   └── index.html        # Web interface
├── static/
│   └── css/
│       └── style.css     # Application styles
├── data/                 # Video files (place your videos here)
├── frames/               # Extracted frame images
└── exports/              # Exported videos and rectangle data
```

## Troubleshooting

### Common Issues

#### FFmpeg Not Found
- **Error**: "FFmpeg not found. Please install FFmpeg."
- **Solution**: Install FFmpeg and ensure it's in your system PATH

#### Video Won't Load
- **Check**: Video file is in the `data/` folder
- **Check**: File format is supported (.mp4, .avi, .mov, .mkv)
- **Check**: Video file isn't corrupted

#### Export Fails
- **Check**: Sufficient disk space in `exports/` folder
- **Check**: Video codec compatibility
- **Try**: Using `libx264` instead of `h264_nvenc`

#### Performance Issues
- **Large videos**: Consider reducing video resolution before processing
- **Memory usage**: Close other applications during export
- **Hardware acceleration**: The application automatically selects the fastest available encoder
- **Manual codec override**: Choose a different codec if auto-selection doesn't work optimally

### Debug Mode

Enable debug output by:
1. Pressing **Ctrl+D** to log rectangle state
2. Opening browser Developer Tools (F12) for console logs
3. Checking Python console for server-side logs

## Technical Notes

- **Frame Rate**: Extracted at 30 FPS for smooth timeline navigation
- **Coordinate System**: Uses image pixel coordinates (top-left origin)
- **Rectangle Persistence**: Rectangles persist across frames until explicitly deleted
- **Memory Management**: Automatic cleanup during frame processing
- **Audio Preservation**: Original audio track is copied to output (when possible)
- **Hardware Encoder Detection**: Automatic scanning for NVIDIA NVENC, Intel QuickSync, and AMD AMF
- **Codec Priority**: NVIDIA NVENC H.264 > Other hardware > Software (libx264)

## Tips for Best Results

1. **Start Small**: Test with short video clips first
2. **Preview First**: Use preview feature before full export
3. **Save Frequently**: Use manual save for important rectangle configurations
4. **Check Audio**: Verify audio compatibility before long exports
5. **Monitor Resources**: Watch disk space and memory usage during export

## Support

For issues or questions:
1. Check the troubleshooting section above
2. Review console logs (browser F12 and Python terminal)
3. Ensure all prerequisites are properly installed
4. Test with different video files to isolate issues