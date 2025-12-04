# Import shared configuration from backend-shared
import config

# Re-export all configuration from the shared module
# service_model_paths removed - was part of old ipexllm inference backend
comfy_ui_root_path = config.comfy_ui_root_path
git = config.git
comfyui_python_exe = config.comfyui_python_exe
comfyui_python_env = config.comfyui_python_env
comfy_ui_model_paths = config.comfy_ui_model_paths
llama_cpp_model_paths = config.llama_cpp_model_paths
openvino_model_paths = config.openvino_model_paths
device = config.device

# Re-export the convert_model_type function
convert_model_type = config.convert_model_type
