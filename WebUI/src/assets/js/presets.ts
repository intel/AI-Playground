export interface Preset {
  workflowName: string
  displayName: string
  description: string
  image: string
}

export const imageGenPresets: Preset[] = [
  {
    workflowName: 'Flux.1-Schnell Med Quality',
    displayName: 'Flux Schnell',
    description: 'Fast and efficient image generation with Flux models. Balances speed and quality.',
    image: '/src/assets/image/flux_schnell.png',
  },
  {
    workflowName: 'Flux.1-Schnell High Quality',
    displayName: 'Flux Schnell HD',
    description: 'Fast and efficient image generation with Flux models. Favors quality over speed.',
    image: '/src/assets/image/flux_schnell.png',
  },
  {
    workflowName: 'FaceSwap-HD',
    displayName: 'FaceSwap',
    description: 'Specialized for swapping faces in images. Ensures realistic results.',
    image: '/src/assets/image/faceswap.png',
  },
  {
    workflowName: 'Acer VisionArt',
    displayName: 'Acer VisionArt',
    description: 'Artistic image generation with Acer\'s vision models. Creates unique visual styles.',
    image: '/src/assets/image/acer_visionart.png',
  },
]

export const imageEditPresets: Preset[] = [
  {
    workflowName: 'Edit By Prompt',
    displayName: 'Edit By Prompt',
    description: 'Modify images based on text prompts. Allows precise editing control.',
    image: '/src/assets/image/editbyprompt.png',
  },
  {
    workflowName: 'Colorize',
    displayName: 'Colorize',
    description: 'Adds color to black-and-white images. Enhances visual appeal automatically.',
    image: '/src/assets/image/colorize.png',
  },
  {
    workflowName: 'CopyFace',
    displayName: 'Copy Face',
    description: 'Copies faces between images seamlessly. Maintains facial details accurately.',
    image: '/src/assets/image/copyface.png',
  },
  {
    workflowName: 'SketchToPhoto-HD-Draft',
    displayName: 'Sketch To Photo Draft',
    description: 'Converts sketches into photorealistic images. Ideal for creative workflows.',
    image: '/src/assets/image/acer_visionart.png',
  },
  {
    workflowName: 'SketchToPhoto-HD-Quality',
    displayName: 'Sketch To Photo HD',
    description: 'Converts sketches into photorealistic images. Ideal for creative workflows.',
    image: '/src/assets/image/acer_visionart.png',
  },
]

export const videoPresets: Preset[] = [
  {
    workflowName: 'Video-Txt2Vid',
    displayName: 'Text to Video - LTX',
    description: 'Generates videos from text prompts using LTX models. Creates dynamic video content.',
    image: '/src/assets/image/flux_schnell.png',
  },
  {
    workflowName: 'Video-Img2Vid',
    displayName: 'Image to Video - LTX',
    description: 'Converts images to videos with LTX technology. Smooth transitions and animations.',
    image: '/src/assets/image/faceswap.png',
  },
  {
    workflowName: 'Video-Start2End',
    displayName: 'Start to End - LTX',
    description: 'Generates videos from start and end frames with LTX. Smooth interpolation.',
    image: '/src/assets/image/flux_schnell.png',
  },
  {
    workflowName: 'Wan2.1-VACE_Img2Video-4Steps',
    displayName: 'Image to Video - VACE',
    description: 'Image-to-video conversion with VACE models. Focus on Speed.',
    image: '/src/assets/image/acer_visionart.png',
  },
  {
    workflowName: 'Wan2.1-VACE_Img2Video-20Steps',
    displayName: 'Image to Video - VACE',
    description: 'Image-to-video conversion with VACE models. High-quality video output.',
    image: '/src/assets/image/acer_visionart.png',
  },
  {
    workflowName: 'Wan2.1-VACE_Video2Video',
    displayName: 'Video to Video - VACE',
    description: 'Transforms existing videos using VACE models. Enables creative video editing.',
    image: '/src/assets/image/acer_visionart.png',
  },
]
