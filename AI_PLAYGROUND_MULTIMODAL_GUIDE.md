# AI Playground Multimodal Integration Guide

## Overview

Your VS Code is now configured to use AI Playground's complete suite of generative models:
- **Text Generation**: Gemma 4, Mistral 7B, Qwen 3, DeepSeek R1
- **Text-to-Image**: SDXL, Stable Diffusion 1.5, Flux
- **Text-to-Video**: LTX-Video, Flux
- **Image-to-Video**: AI Playground's video generation models
- **Image Analysis**: Qwen Vision, InternVL

## Quick Start

### 1. Start AI Playground
Launch the AI Playground desktop app on your PC.

### 2. Open Continue in VS Code
- Click the **Continue icon** on the left sidebar (looks like a continue loop)
- Or press `Ctrl+L` to open the chat

### 3. Use the Commands

#### Generate Images
```
/image Create a futuristic tech office with natural lighting and plants
```

Or use natural language:
```
Can you generate an image of a serene Japanese garden at sunset?
```

#### Generate Videos
```
/video Show a time-lapse of clouds moving across a blue sky
```

#### Analyze Images
```
/analyze-image [Upload an image] What's the main subject in this image?
```

#### Image-to-Video
```
Turn this screenshot into a video showing the UI elements coming to life
```

## Slash Commands in Continue

| Command | Purpose | Example |
|---------|---------|---------|
| `/image` | Text-to-image generation | `/image cyberpunk city scene` |
| `/video` | Text-to-video generation | `/video rain falling on a window` |
| `/analyze-image` | Vision-based image analysis | `/analyze-image What's in this code screenshot?` |
| `/outline` | Create code structure | `/outline Plan a React component for a dashboard` |
| `/edit` | Edit code with AI | `/edit Make this function more efficient` |

## Custom Commands

Use these pre-configured custom commands for quick access:

- **Generate Image** - Full image generation workflow
- **Generate Video** - Video creation with parameters
- **Image to Video** - Convert static images to motion

## Model Selection

To use specific models, mention them in your request:

### For Images:
```
Generate an SDXL image of a futuristic city
Generate a Flux image with more detail
```

### For Videos:
```
Create a video using LTX-Video showing a car driving
Create a Flux video of water ripples
```

### For Analysis:
```
Using Qwen Vision, analyze this screenshot
Analyze this image with InternVL
```

## API Endpoints (Advanced)

If you want to call these directly from code:

### Generate Image
```javascript
POST http://localhost:8000/api/generate-image
{
  "prompt": "description",
  "model": "sdxl|sd15|flux",
  "steps": 30,
  "scheduler": "normal",
  "cfg_scale": 7.5,
  "width": 768,
  "height": 768
}
```

### Generate Video
```javascript
POST http://localhost:8000/api/generate-video
{
  "prompt": "description",
  "model": "ltx-video|flux",
  "duration": 5,
  "fps": 24,
  "guidance_scale": 7.5
}
```

### Image Analysis
```javascript
POST http://localhost:8000/v1/chat/completions
{
  "model": "qwen-vl|internvl-2",
  "messages": [{
    "role": "user",
    "content": [
      {"type": "image_url", "image_url": {"url": "..."}},
      {"type": "text", "text": "question"}
    ]
  }]
}
```

## Troubleshooting

### Models not responding?
1. Verify AI Playground app is running
2. Check the localhost endpoint (default: http://localhost:8000)
3. Open AI Playground settings to confirm backend is active

### Images/videos generating slowly?
- This is normal for first-time inference
- Subsequent generations cache models in VRAM for faster performance
- A770 GPU will use hardware acceleration automatically

### Change API endpoint
Edit `~/.continue/config.json` and update the `apiBase`:
```json
"apiBase": "http://your-ip:8000/v1"
```

## Tips & Tricks

### Chain Generations
```
First, generate an image of a sunset over mountains. 
Then turn that image into a video showing the sun setting in real-time.
```

### Use for Documentation
```
/analyze-image [Screenshot] Explain what this code does
```

### UI/UX Design
```
/image Create a modern dark-mode dashboard UI mockup
```

### Content Creation
```
/video Create a 5-second video showing a website loading animation
```

## Performance Notes

- **First Generation**: 30-120 seconds (model loading)
- **Subsequent Generations**: 10-30 seconds (cached in VRAM)
- **A770 Optimization**: Your Intel Arc A770 GPU is automatically detected and utilized
- **Model Selection**: Smaller models (Mistral, Phi3) = faster responses

## Support

For API endpoint details and advanced configuration, refer to:
- AI Playground Users Guide
- Continue.dev documentation: https://docs.continue.dev
- AI Playground service configuration: `service/config.py`

## Next Steps

1. **Try a simple image**: `/image a red cube`
2. **Generate a video**: `/video a ball bouncing`
3. **Analyze something**: `/analyze-image [code screenshot] what error is this?`
4. **Create an agent prompt**: Use these tools in custom agent definitions

Happy creating! 🎨🎬
