from flask import Flask, render_template, request, jsonify, send_file
import os
import json
import subprocess
import shutil
from PIL import Image, ImageFilter
import base64
from io import BytesIO

app = Flask(__name__)

UPLOAD_FOLDER = 'data'
FRAMES_FOLDER = 'frames'
EXPORT_FOLDER = 'exports'

for folder in [UPLOAD_FOLDER, FRAMES_FOLDER, EXPORT_FOLDER]:
    os.makedirs(folder, exist_ok=True)

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
    
    # Create folder if it doesn't exist
    os.makedirs(video_frames_folder, exist_ok=True)
    
    frame_pattern = os.path.join(video_frames_folder, 'frame_%06d.jpg')
    
    try:
        print(f"Extracting frames for {video_name}...")
        cmd = [
            'ffmpeg', '-i', video_path,
            '-vf', 'fps=fps=30',  # Extract at 30 fps for smooth timeline
            '-q:v', '2',  # High quality
            '-y',  # Overwrite existing files
            frame_pattern
        ]
        
        result = subprocess.run(cmd, capture_output=True, text=True, check=True)
        
        frame_files = sorted([f for f in os.listdir(video_frames_folder) if f.startswith('frame_')])
        frames_info = []
        
        for i, filename in enumerate(frame_files):
            frames_info.append({
                'index': i,
                'filename': filename,
                'path': os.path.join(video_frames_folder, filename)
            })
        
        print(f"Extracted {len(frame_files)} frames for {video_name}")
        return jsonify({
            'frames': frames_info, 
            'total': len(frame_files),
            'cached': False,
            'message': f'Extracted {len(frame_files)} new frames'
        })
        
    except subprocess.CalledProcessError as e:
        return jsonify({'error': f'FFmpeg error: {e.stderr}'}), 500
    except FileNotFoundError:
        return jsonify({'error': 'FFmpeg not found. Please install FFmpeg.'}), 500

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

def apply_gaussian_blur(image, blur_radius=15):
    """Apply Gaussian blur effect to an image region"""
    return image.filter(ImageFilter.GaussianBlur(radius=blur_radius))

@app.route('/export_blurred', methods=['POST'])
def export_blurred():
    data = request.json
    video_name = data['video_name']
    all_frame_rectangles = data.get('all_frame_rectangles', {})
    blur_radius = data.get('blur_radius', 15)  # Default to 15px blur radius
    
    original_video_path = os.path.join(UPLOAD_FOLDER, video_name)
    video_frames_folder = os.path.join(FRAMES_FOLDER, video_name.split('.')[0])
    export_video_name = f'blurred_{video_name}'
    export_video_path = os.path.join(EXPORT_FOLDER, export_video_name)
    
    try:
        # Create blurred frames for all frames that have rectangles
        blurred_frames_folder = os.path.join(FRAMES_FOLDER, f"{video_name.split('.')[0]}_blurred")
        os.makedirs(blurred_frames_folder, exist_ok=True)
        
        # First, copy all original frames to the blurred folder
        frame_files = sorted([f for f in os.listdir(video_frames_folder) if f.startswith('frame_')])
        
        for frame_file in frame_files:
            original_frame_path = os.path.join(video_frames_folder, frame_file)
            blurred_frame_path = os.path.join(blurred_frames_folder, frame_file)
            
            # Extract frame index from filename (FFmpeg starts from 1, but UI uses 0-based)
            ffmpeg_frame_number = int(frame_file.split('_')[1].split('.')[0])
            ui_frame_index = ffmpeg_frame_number - 1  # Convert to 0-based indexing for UI
            
            # Check if this frame has rectangles to blur
            if str(ui_frame_index) in all_frame_rectangles and all_frame_rectangles[str(ui_frame_index)]:
                # Apply blur to this frame
                image = Image.open(original_frame_path)
                
                for rect in all_frame_rectangles[str(ui_frame_index)]:
                    x, y, width, height = rect['x'], rect['y'], rect['width'], rect['height']
                    region = image.crop((x, y, x + width, y + height))
                    blurred_region = apply_gaussian_blur(region, blur_radius=blur_radius)
                    image.paste(blurred_region, (x, y))
                
                image.save(blurred_frame_path)
            else:
                # No rectangles, just copy the original frame
                shutil.copy2(original_frame_path, blurred_frame_path)
        
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
        
        # Video encoding settings to match original
        cmd.extend([
            '-c:v', video_stream.get('codec_name', 'libx264'),  # Use original codec or default to h264
            '-pix_fmt', video_stream.get('pix_fmt', 'yuv420p'),  # Use original pixel format
        ])
        
        # Add bitrate if available
        if 'bit_rate' in video_stream:
            cmd.extend(['-b:v', video_stream['bit_rate']])
        
        cmd.append(export_video_path)
        
        # Execute FFmpeg command
        print(f"Executing FFmpeg command: {' '.join(cmd)}")
        result = subprocess.run(cmd, capture_output=True, text=True, check=True)
        print("FFmpeg export completed successfully")
        
        # Build success message
        audio_info = " (with audio)" if audio_stream else " (video only - no audio in original)"
        success_message = f'Video exported with blur effect{audio_info}: {export_video_name}'
        
        return jsonify({
            'export_path': export_video_path,
            'filename': export_video_name,
            'message': success_message,
            'has_audio': bool(audio_stream)
        })
        
    except subprocess.CalledProcessError as e:
        error_msg = e.stderr
        print(f"FFmpeg error: {error_msg}")
        
        # If there's an audio-related error, try without audio
        if audio_stream and ('audio' in error_msg.lower() or 'stream' in error_msg.lower()):
            print("Retrying export without audio due to audio stream error...")
            try:
                # Retry without audio
                cmd_no_audio = [
                    'ffmpeg', '-y',
                    '-framerate', str(eval(video_stream['r_frame_rate'])),
                    '-i', frame_pattern,
                    '-c:v', video_stream.get('codec_name', 'libx264'),
                    '-pix_fmt', video_stream.get('pix_fmt', 'yuv420p'),
                ]
                
                if 'bit_rate' in video_stream:
                    cmd_no_audio.extend(['-b:v', video_stream['bit_rate']])
                
                cmd_no_audio.append(export_video_path)
                
                result = subprocess.run(cmd_no_audio, capture_output=True, text=True, check=True)
                
                return jsonify({
                    'export_path': export_video_path,
                    'filename': export_video_name,
                    'message': f'Video exported with blur effect (audio excluded due to compatibility issue): {export_video_name}',
                    'has_audio': False,
                    'warning': 'Audio could not be copied due to compatibility issues'
                })
                
            except subprocess.CalledProcessError as retry_error:
                return jsonify({'error': f'FFmpeg error (retry failed): {retry_error.stderr}'}), 500
        
        return jsonify({'error': f'FFmpeg error: {error_msg}'}), 500
    except Exception as e:
        return jsonify({'error': f'Export error: {str(e)}'}), 500

@app.route('/save_rectangles', methods=['POST'])
def save_rectangles():
    data = request.json
    video_name = data['video_name']
    all_frame_rectangles = data.get('all_frame_rectangles', {})
    
    # Create rectangles data structure
    rectangles_data = {
        'video_name': video_name,
        'timestamp': data.get('timestamp'),
        'frames': []
    }
    
    # Convert frame rectangles to structured format
    for frame_index, rectangles in all_frame_rectangles.items():
        frame_data = {
            'frame_number': int(frame_index),
            'rectangles': []
        }
        
        for i, rect in enumerate(rectangles):
            rectangle_data = {
                'id': f"frame_{frame_index}_rect_{i}",
                'x': rect['x'],
                'y': rect['y'],
                'width': rect['width'],
                'height': rect['height']
            }
            frame_data['rectangles'].append(rectangle_data)
        
        rectangles_data['frames'].append(frame_data)
    
    # Sort frames by frame number
    rectangles_data['frames'].sort(key=lambda x: x['frame_number'])
    
    # Save to JSON file
    filename = f"rectangles_{video_name.split('.')[0]}.json"
    filepath = os.path.join(EXPORT_FOLDER, filename)
    
    try:
        with open(filepath, 'w') as f:
            json.dump(rectangles_data, f, indent=2)
        
        return jsonify({
            'success': True,
            'filename': filename,
            'filepath': filepath,
            'total_frames': len(rectangles_data['frames']),
            'total_rectangles': sum(len(frame['rectangles']) for frame in rectangles_data['frames'])
        })
    
    except Exception as e:
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
    
    if os.path.exists(filepath):
        try:
            with open(filepath, 'r') as f:
                rectangles_data = json.load(f)
            
            # Convert from saved format back to frame rectangles format
            frame_rectangles = {}
            for frame_data in rectangles_data.get('frames', []):
                frame_number = frame_data['frame_number']
                frame_rectangles[str(frame_number)] = []
                
                for rect_data in frame_data['rectangles']:
                    frame_rectangles[str(frame_number)].append({
                        'x': rect_data['x'],
                        'y': rect_data['y'],
                        'width': rect_data['width'],
                        'height': rect_data['height']
                    })
            
            return jsonify({
                'success': True,
                'frame_rectangles': frame_rectangles,
                'total_frames': len(frame_rectangles),
                'total_rectangles': sum(len(rects) for rects in frame_rectangles.values()),
                'filename': filename
            })
            
        except Exception as e:
            return jsonify({'error': f'Failed to load rectangles: {str(e)}'}), 500
    else:
        return jsonify({
            'success': True,
            'frame_rectangles': {},
            'total_frames': 0,
            'total_rectangles': 0,
            'message': 'No existing rectangle data found'
        })

if __name__ == '__main__':
    app.run(debug=True)