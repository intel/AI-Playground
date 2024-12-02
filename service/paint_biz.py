import gc
import os
import queue
import random
import time
from typing import Any, Callable, Dict, List
import aipg_utils as utils
import model_config
import inpaint_utils
from diffusers import (
    DiffusionPipeline,
    StableDiffusionPipeline,
    StableDiffusionXLPipeline,
    AutoPipelineForInpainting,
    AutoPipelineForImage2Image,
    StableDiffusionImg2ImgPipeline,
    StableDiffusionXLImg2ImgPipeline,
    StableDiffusionInpaintPipeline,
    StableDiffusionXLInpaintPipeline,
    LCMScheduler,
    AutoencoderTiny,
)
from diffusers.pipelines.stable_diffusion.safety_checker import (
    StableDiffusionSafetyChecker,
)
import torch
from PIL import Image
from realesrgan import RealESRGANer
import re
import schedulers_util
from compel import Compel
from threading import Event
from xpu_hijacks import ipex_hijacks

ipex_hijacks()
print("workarounds applied")

# region class define


class TextImageParams:
    device: int
    prompt: str
    model_name: str
    mode: int
    """
    0-text to image 1-upscale 2-image to image 3-inpaint 4-outpaint
    """
    width: int
    height: int
    generate_number: int
    seed: int
    guidance_scale: int
    inference_steps: int
    negative_prompt: str
    lora: str
    scheduler: str
    image_preview: int
    safe_check: int


class ImageToImageParams(TextImageParams):
    image: str
    denoise: float


class UpscaleImageParams(ImageToImageParams):
    scale: float


class InpaintParams(ImageToImageParams):
    mask_image: str


class OutpaintParams(ImageToImageParams):
    direction: str


class StopGenerateException(Exception):
    def __str__(self):
        return "user stop generate image"


class NoWatermark:
    def apply_watermark(self, img):
        return img


# endregion


# region global variable

_basic_model_pipe: StableDiffusionPipeline | StableDiffusionXLPipeline = None
_ext_model_pipe: (
    StableDiffusionPipeline
    | StableDiffusionXLPipeline
    | StableDiffusionImg2ImgPipeline
    | StableDiffusionXLImg2ImgPipeline
    | StableDiffusionInpaintPipeline
    | StableDiffusionXLInpaintPipeline
) = None
_realESRGANer: RealESRGANer = None
_last_mode: int = None
_last_model_name: str = None
_generate_idx: int
_default_scheduler: LCMScheduler = None
_last_lora: str = "None"
_last_scheduler: str = "None"
load_model_callback: Callable[[str], None] = None
load_model_components_callback: Callable[[str], None] = None
download_progress_callback: Callable[[str, int, int, int], None] = (None,)
download_completed_callback: Callable[[str, Exception], None] = (None,)
step_end_callback: Callable[[int, int, int, Image.Image | None], None] = None
image_out_callback: Callable[[int, Image.Image, Any], None] = None
_taesd_vae: AutoencoderTiny = None
_taesd_vae_type: str = None
_preview_enabled = 0
_stop_generate = False
_generating = False
_stop_event = Event()
_preview_queue = queue.Queue()
_safety_checker: StableDiffusionSafetyChecker = None

# endregion


# region load model


def get_basic_model(input_model_name: str) -> DiffusionPipeline | Any:
    global \
        _last_model_name, \
        _basic_model_pipe, \
        load_model_callback, \
        _last_lora, \
        _last_scheduler, \
        _taesd_vae, \
        _safety_checker

    assert_stop_generate()

    if _last_model_name == input_model_name and _basic_model_pipe is not None:
        return _basic_model_pipe

    mode_name_array = input_model_name.split(":")
    config_key = mode_name_array[0]
    model_name = mode_name_array[1]
    model_base_path = model_config.config.get(config_key)

    start = time.time()
    if load_model_callback is not None:
        load_model_callback("start")

    if utils.is_single_file(model_name):
        # single_file_mode
        model_path = os.path.abspath(os.path.join(model_base_path, model_name))

        if not os.path.exists(model_path):
            raise Exception(f'can not find model "{model_name}"', model_path)

        _basic_model_pipe = load_model_from_single_file(model_path)
    else:
        model_floder = model_name.replace("/", "---")
        model_path = os.path.abspath(
            os.path.join(model_base_path, model_floder, "model_index.json")
        )
        if not os.path.exists(model_path):
            raise Exception(f'can not find model "{model_name}"', model_path)

        _basic_model_pipe = load_model_from_pretrained(
            os.path.abspath(os.path.join(model_base_path, model_floder))
        )

    _last_lora = "None"
    _last_scheduler = "None"

    assert_stop_generate()

    _basic_model_pipe.watermark = NoWatermark()
    if isinstance(_basic_model_pipe, StableDiffusionPipeline):
        _safety_checker = _basic_model_pipe.safety_checker
        _basic_model_pipe.safety_checker = None
    else:
        _safety_checker = None
    # perf optimization
    _basic_model_pipe.enable_model_cpu_offload()
    _basic_model_pipe.enable_vae_tiling()
    _basic_model_pipe.to(model_config.device)

    print(
        "load model {} finish. cost {}s".format(
            model_name, round(time.time() - start, 3)
        )
    )

    if load_model_callback is not None:
        load_model_callback("finish")
    _last_model_name = input_model_name

    print(_basic_model_pipe)
    return _basic_model_pipe


def process_preview_taesd():
    global _taesd_vae_type, _taesd_vae

    if isinstance(
        _basic_model_pipe,
        StableDiffusionXLPipeline
        | StableDiffusionXLImg2ImgPipeline
        | StableDiffusionXLInpaintPipeline,
    ) and (_taesd_vae_type != "sdxl" or _taesd_vae is None):
        _taesd_vae = AutoencoderTiny.from_pretrained(
            os.path.join(model_config.config.get("preview"), "madebyollin---taesdxl"),
            torch_dtype=torch.bfloat16,
        )
        _taesd_vae_type = "sdxl"
    elif isinstance(
        _basic_model_pipe,
        StableDiffusionPipeline
        | StableDiffusionImg2ImgPipeline
        | StableDiffusionInpaintPipeline,
    ) and (_taesd_vae_type != "sd1.5" or _taesd_vae is None):
        _taesd_vae = AutoencoderTiny.from_pretrained(
            os.path.join(model_config.config.get("preview"), "madebyollin---taesd"),
            torch_dtype=torch.bfloat16,
        )
        _taesd_vae_type = "sd1.5"

    _taesd_vae.to(model_config.device)


def get_ext_pipe(params: TextImageParams, pipe_classes: List, init_class: any):
    global _basic_model_pipe, _ext_model_pipe

    if _ext_model_pipe is not None:
        for cls in pipe_classes:
            if isinstance(_ext_model_pipe, cls):
                return _ext_model_pipe
        del _ext_model_pipe
        gc.collect()
        torch.xpu.empty_cache()

    basic_model_pipe = get_basic_model(params.model_name)
    _ext_model_pipe = init_class.from_pipe(basic_model_pipe)
    _ext_model_pipe.to(model_config.device)

    assert_stop_generate()

    return _ext_model_pipe


def load_model_from_single_file(model_signle_file: str):
    base_name = os.path.basename(model_signle_file)
    is_xl = re.search("[-_]xl[-_\.]", base_name, flags=re.I) is not None
    if is_xl:
        try:
            pipe = StableDiffusionXLPipeline.from_single_file(
                model_signle_file, torch_dtype=torch.bfloat16
            )

        except Exception:
            pipe = StableDiffusionPipeline.from_single_file(
                model_signle_file, torch_dtype=torch.bfloat16
            )
    else:
        try:
            pipe = StableDiffusionPipeline.from_single_file(
                model_signle_file, torch_dtype=torch.bfloat16
            )
        except Exception:
            pipe = StableDiffusionXLPipeline.from_single_file(
                model_signle_file, torch_dtype=torch.bfloat16
            )
    return pipe


def load_model_from_pretrained(model_dir: str):
    if os.path.exists(
        os.path.join(model_dir, "unet/diffusion_pytorch_model.fp32.safetensors")
    ) or os.path.exists(
        os.path.join(model_dir, "unet/diffusion_pytorch_model.fp32.bin")
    ):
        pipe = DiffusionPipeline.from_pretrained(
            model_dir,
            torch_dtype=torch.float32,
            variant="fp32",
            device=model_config.device,
        )
    elif os.path.exists(
        os.path.join(model_dir, "unet/diffusion_pytorch_model.fp16.safetensors")
    ) or os.path.exists(
        os.path.join(model_dir, "unet/diffusion_pytorch_model.fp16.bin")
    ):
        pipe = DiffusionPipeline.from_pretrained(
            model_dir, torch_dtype=torch.bfloat16, variant="fp16"
        )
    else:
        pipe = DiffusionPipeline.from_pretrained(model_dir, torch_dtype=torch.bfloat16)
    return pipe


def set_lora(pipe: StableDiffusionPipeline | StableDiffusionXLPipeline, lora: str):
    global \
        _default_scheduler, \
        _last_lora, \
        download_progress_callback, \
        download_completed_callback
    if lora == _last_lora:
        return
    if lora != "None":
        base_path = model_config.config.get("lora")

        if utils.is_single_file(lora):
            lora_path = os.path.join(base_path, lora)
            if not os.path.exists(lora_path):
                raise Exception(f"not found lora {lora} in dir {base_path}")
            pipe.load_lora_weights(base_path, weight_name=lora, low_cpu_mem_usage=True)
        else:
            lora_path = os.path.join(base_path, lora.replace("/", "---"))
            if not os.path.exists(lora_path):
                raise Exception(f"not found lora {lora} in dir {base_path}")
            pipe.load_lora_weights(lora_path)

        print(f"Loaded LORA weights from {lora}.")
    elif _last_lora is not None:
        pipe.unload_lora_weights()
        print("Restored the default LORA.")
    _last_lora = lora


def set_scheduler(
    pipe: StableDiffusionPipeline | StableDiffusionXLPipeline, scheduler_name: str
):
    global _last_scheduler
    schedulers_util.set_scheduler(pipe, scheduler_name)
    _last_scheduler = scheduler_name


def set_components(
    pipe: (
        StableDiffusionPipeline
        | StableDiffusionXLPipeline
        | StableDiffusionInpaintPipeline
        | StableDiffusionXLInpaintPipeline
    ),
    params: TextImageParams,
):
    global \
        _last_scheduler, \
        _last_lora, \
        load_model_components_callback, \
        _taesd_vae, \
        _safety_checker

    if load_model_components_callback is not None:
        load_model_components_callback("start")

    if params.image_preview == 1:
        process_preview_taesd()

    if params.safe_check and isinstance(
        pipe, StableDiffusionPipeline | StableDiffusionInpaintPipeline
    ):
        pipe.safety_checker = _safety_checker
    else:
        pipe.safety_checker = None

    if params.scheduler != _last_scheduler:
        set_scheduler(pipe, params.scheduler)
        _last_scheduler = params.scheduler
    assert_stop_generate()
    if params.lora != _last_lora:
        set_lora(pipe, params.lora)
    assert_stop_generate()

    if load_model_components_callback is not None:
        load_model_components_callback("finish")


def get_ESRGANer():
    global _realESRGANer
    if _realESRGANer is None:
        _realESRGANer = RealESRGANer()
    _realESRGANer.to(model_config.device)
    return _realESRGANer


def convert_prompt_to_compel_format(prompt):
    # convert prompt to compel supported prompt weighting format
    converted = re.sub(r"\(([^:]+):([\d.]+)\)", r"(\1)\2", prompt)
    converted = re.sub(r"\[([^:\]]+)\]", r"(\1)0.909090909", converted)
    converted = re.sub(r"\[([^:]+):[\d.]+\]", r"(\1)0.9", converted)
    return converted


# endregion


# region preview


def __callback_on_step_end__(
    model: (
        StableDiffusionPipeline
        | StableDiffusionXLPipeline
        | StableDiffusionInpaintPipeline
        | StableDiffusionXLInpaintPipeline
    ),
    step: int,
    timesteps: int,
    callback_kwargs: Dict,
):
    global \
        step_end_callback, \
        _generate_idx, \
        _preview_enabled, \
        _taesd_vae, \
        _preview_queue

    assert_stop_generate()

    if step_end_callback is not None:
        if _preview_enabled == 1:
            latents: torch.FloatTensor = callback_kwargs["latents"]
            # put preiview task to preview thread task queue
            if step % 4 == 0:
                with torch.no_grad():
                    image = _taesd_vae.decode(latents).sample
                    image = (image / 2 + 0.5).clamp(0, 1)
                    # we always cast to float32 as this does not cause significant overhead and is compatible with bfloa16
                    image = image.cpu().permute(0, 2, 3, 1).float().numpy()
                    # convert to PIL Images
                    image = model.numpy_to_pil(image)
                    step_end_callback(
                        _generate_idx,
                        step,
                        model.num_timesteps,
                        _preview_enabled,
                        image[0],
                    )
            else:
                step_end_callback(
                    _generate_idx, step, model.num_timesteps, _preview_enabled, None
                )

        else:
            step_end_callback(
                _generate_idx, step, model.num_timesteps, _preview_enabled, None
            )

    return callback_kwargs


# endregion


# region generate_image_function


def convet_compel_prompt(
    prompt: str, pipe: StableDiffusionPipeline | StableDiffusionXLPipeline
):
    custom_inputs = {}

    if hasattr(pipe, "text_encoder_2") and hasattr(pipe, "tokenizer_2"):
        custom_inputs.update({"prompt": prompt})
        # compel_proc2 = Compel(
        #     tokenizer=[pipe.tokenizer, pipe.tokenizer_2],
        #     text_encoder=[pipe.text_encoder, pipe.text_encoder_2],
        #     returned_embeddings_type=ReturnedEmbeddingsType.PENULTIMATE_HIDDEN_STATES_NON_NORMALIZED,
        #     requires_pooled=[False, True],
        # )
        # compel_prompt2 = convert_prompt_to_compel_format(prompt)
        # pooled_prompt = [compel_prompt2, ""]
        # prompt_embeds, pooled_prompt_embeds = compel_proc2(pooled_prompt)
        # custom_inputs.update(
        #     {
        #         "prompt_embeds": prompt_embeds,
        #         "pooled_prompt_embeds": pooled_prompt_embeds,
        #     }
        # )
    else:
        compel_proc = Compel(tokenizer=pipe.tokenizer, text_encoder=pipe.text_encoder)
        compel_prompt = convert_prompt_to_compel_format(prompt)
        prompt_embeds = compel_proc(compel_prompt)
        custom_inputs.update(
            {
                "prompt_embeds": prompt_embeds,
            }
        )

    return custom_inputs


def text_to_image(
    params: TextImageParams,
):
    global _generate_idx, image_out_callback
    pipe = get_basic_model(params.model_name)
    set_components(pipe, params)
    pipe.to(model_config.device)

    custom_inputs = convet_compel_prompt(params.prompt, pipe)
    seed = params.seed

    _generate_idx = 0

    with torch.inference_mode():
        while _generate_idx < params.generate_number:
            params.seed = (
                random.randint(0, 0xFFFFFFFE)
                if seed == -1
                else seed + _generate_idx & 0xFFFFFFFF
            )
            params.seed = 0 if params.seed == 0xFFFFFFFF else params.seed
            generator = torch.Generator("cpu").manual_seed(params.seed)

            image = pipe(
                width=params.width,
                height=params.height,
                generator=generator,
                num_inference_steps=params.inference_steps,
                guidance_scale=params.guidance_scale,
                callback_on_step_end=__callback_on_step_end__,
                **custom_inputs,
            ).images[0]

            output_image(pipe, image, params)
            _generate_idx += 1


def image_to_image(params: ImageToImageParams):
    global _generate_idx, image_out_callback
    pipe = get_ext_pipe(
        params,
        [StableDiffusionImg2ImgPipeline, StableDiffusionXLImg2ImgPipeline],
        AutoPipelineForImage2Image,
    )

    set_components(pipe, params)
    pipe.to(model_config.device)
    input_image = Image.open(params.image)
    input_image = (
        input_image.convert("RGB") if input_image.mode != "RGB" else input_image
    )
    if input_image.width != params.width or input_image.height != params.height:
        input_image = input_image.resize((params.width, params.height))

    seed = params.seed

    _generate_idx = 0
    custom_inputs = convet_compel_prompt(params.prompt, pipe)
    seed = params.seed
    with torch.inference_mode():
        while _generate_idx < params.generate_number:
            params.seed = (
                random.randint(0, 0xFFFFFFFE)
                if seed == -1
                else seed + _generate_idx & 0xFFFFFFFF
            )
            params.seed = 0 if params.seed == 0xFFFFFFFF else params.seed
            generator = torch.Generator("cpu").manual_seed(params.seed)

            image = pipe(
                image=input_image,
                width=params.width,
                height=params.height,
                generator=generator,
                strength=params.denoise,
                guidance_scale=params.guidance_scale,
                num_inference_steps=params.inference_steps,
                negative_prompt=params.negative_prompt,
                callback_on_step_end=__callback_on_step_end__,
                **custom_inputs,
            ).images[0]

            output_image(pipe, image, params)

            _generate_idx += 1


def upscale(params: UpscaleImageParams):
    global image_out_callback, _generate_idx, _ext_model_pipe

    input_image = Image.open(params.image)

    input_image = (
        input_image.convert("RGB") if input_image.mode != "RGB" else input_image
    )

    if params.denoise <= 0.1:
        out_image = Image.fromarray(
            get_ESRGANer().enhance(input_image, params.scale)[0]
        )
        if image_out_callback is not None:
            image_out_callback(0, out_image, params)
    else:
        pipe = get_ext_pipe(
            params,
            [StableDiffusionImg2ImgPipeline, StableDiffusionXLImg2ImgPipeline],
            AutoPipelineForImage2Image,
        )
        set_components(pipe, params)
        pipe.to(model_config.device)

        custom_inputs = convet_compel_prompt(params.prompt, pipe)
        seed = params.seed
        _generate_idx = 0
        with torch.inference_mode():
            # while _generate_idx < params.generate_number:
            #     params.seed = (
            #         random.randint(0, 0xFFFFFFFE)
            #         if seed == -1
            #         else seed + _generate_idx & 0xFFFFFFFF
            #     )
            params.seed = 0 if params.seed == 0xFFFFFFFF else params.seed
            generator = torch.Generator("cpu").manual_seed(seed)
            out_image = pipe(
                image=input_image,
                width=input_image.width,
                height=input_image.height,
                generator=generator,
                strength=params.denoise,
                guidance_scale=params.guidance_scale,
                num_inference_steps=params.inference_steps,
                negative_prompt=params.negative_prompt,
                callback_on_step_end=__callback_on_step_end__,
                **custom_inputs,
            ).images[0]
            out_image = Image.fromarray(
                get_ESRGANer().enhance(out_image, params.scale)[0]
            )
            params.width = out_image.width
            params.height = out_image.height
            output_image(pipe, out_image, params)
            # _generate_idx += 1


def inpaint(params: InpaintParams):
    global _generate_idx, image_out_callback

    pipe = get_ext_pipe(
        params,
        [StableDiffusionInpaintPipeline, StableDiffusionXLInpaintPipeline],
        AutoPipelineForInpainting,
    )

    set_components(pipe, params)
    pipe.to(model_config.device)

    input_image = Image.open(params.image)
    mask_image = Image.open(params.mask_image)
    input_image = (
        input_image.convert("RGB") if input_image.mode != "RGB" else input_image
    )
    mask_image = mask_image.convert("RGB") if mask_image.mode != "RGB" else mask_image

    slice_image, mask_image, slice_box = inpaint_utils.pre_input_and_mask(
        input_image, mask_image
    )

    slice_w, slice_h = slice_image.size
    out_width, out_height, out_radio = inpaint_utils.calc_out_size(
        slice_w, slice_h, isinstance(pipe, StableDiffusionXLInpaintPipeline)
    )
    if out_radio != 1:
        slice_image = slice_image.resize((out_width, out_height))
        mask_image = mask_image.resize((out_width, out_height))

    mask_image = pipe.mask_processor.blur(mask_image, blur_factor=33)
    seed = params.seed
    _generate_idx = 0

    custom_inputs = convet_compel_prompt(params.prompt, pipe)
    with torch.inference_mode():
        while _generate_idx < params.generate_number:
            params.seed = (
                random.randint(0, 0xFFFFFFFE)
                if seed == -1
                else seed + _generate_idx & 0xFFFFFFFF
            )
            params.seed = 0 if params.seed == 0xFFFFFFFF else params.seed
            generator = torch.Generator("cpu").manual_seed(params.seed)

            repainted_image: Image.Image = pipe(
                **custom_inputs,
                image=slice_image,
                mask_image=mask_image,
                strength=params.denoise,
                width=out_width,
                height=out_height,
                generator=generator,
                guidance_scale=params.guidance_scale,
                num_inference_steps=params.inference_steps,
                negative_prompt=params.negative_prompt,
                callback_on_step_end=__callback_on_step_end__,
                force_unmasked_unchanged=True,
            ).images[0]

            gen_image = pipe.image_processor.apply_overlay(
                mask_image, slice_image, repainted_image
            )

            if out_radio != 1:
                realESRGANer = get_ESRGANer()
                gen_image = Image.fromarray(
                    realESRGANer.enhance(gen_image, out_radio)[0]
                )

            slice_width = slice_box[2] - slice_box[0]
            slice_height = slice_box[3] - slice_box[1]
            if gen_image.height != slice_width or gen_image.width != slice_height:
                gen_image = gen_image.resize((slice_width, slice_height))

            input_image.paste(gen_image, slice_box)

            output_image(pipe, input_image, params)
            _generate_idx += 1


def outpaint(params: OutpaintParams):
    from outpaint_utils import preprocess_outpaint

    global _generate_idx, image_out_callback

    pipe = get_ext_pipe(
        params,
        [StableDiffusionInpaintPipeline, StableDiffusionXLInpaintPipeline],
        AutoPipelineForInpainting,
    )
    set_components(pipe, params)

    pipe.to(model_config.device)
    if isinstance(pipe, StableDiffusionXLInpaintPipeline):
        max_size = 1536
    else:
        max_size = 768

    ori_image = Image.open(params.image)

    if ori_image.mode != "RGB":
        ori_image = ori_image.convert("RGB")

    new_width = inpaint_utils.make_multiple_of_8(ori_image.width)
    new_height = inpaint_utils.make_multiple_of_8(ori_image.height)
    if new_width != ori_image.width or new_height != ori_image.width:
        ori_image = ori_image.resize((new_width, new_height))

    expand_image, inpaint_mask = preprocess_outpaint(params.direction, ori_image)

    inpaint_image, scale_ratio = inpaint_utils.resize_by_max(expand_image, max_size)
    out_width = inpaint_utils.make_multiple_of_8(inpaint_image.width)
    out_height = inpaint_utils.make_multiple_of_8(inpaint_image.height)

    if out_width != inpaint_image.width or out_height != inpaint_image.height:
        inpaint_image = inpaint_image.resize((out_width, out_height))

    inpaint_mask = inpaint_mask.resize((out_width, out_height))

    seed = params.seed
    _generate_idx = 0
    custom_inputs = convet_compel_prompt(params.prompt, pipe)
    with torch.inference_mode():
        while _generate_idx < params.generate_number:
            params.seed = (
                random.randint(0, 0xFFFFFFFE)
                if seed == -1
                else seed + _generate_idx & 0xFFFFFFFF
            )
            params.seed = 0 if params.seed == 0xFFFFFFFF else params.seed
            generator = torch.Generator("cpu").manual_seed(params.seed)
            repainted_image: Image.Image = pipe(
                **custom_inputs,
                image=inpaint_image,
                mask_image=inpaint_mask,
                strength=params.denoise,
                width=out_width,
                height=out_height,
                generator=generator,
                guidance_scale=params.guidance_scale,
                num_inference_steps=params.inference_steps,
                negative_prompt=params.negative_prompt,
                callback_on_step_end=__callback_on_step_end__,
                force_unmasked_unchanged=True,
            ).images[0]

            unmasked_unchanged_image = pipe.image_processor.apply_overlay(
                inpaint_mask, inpaint_image, repainted_image
            )

            if scale_ratio != 1:
                unmasked_unchanged_image = Image.fromarray(
                    get_ESRGANer().enhance(unmasked_unchanged_image, scale_ratio)[0]
                )

            output_image(pipe, unmasked_unchanged_image, params)
            _generate_idx += 1


def is_image_completely_black(image: Image):
    pixels = image.getdata()
    return all(pixel == (0, 0, 0) for pixel in pixels)


def output_image(
    pipe: StableDiffusionPipeline | StableDiffusionXLPipeline,
    image: Image.Image,
    params: TextImageParams,
):
    global image_out_callback, _safety_checker, _generate_idx
    passed_safety_check = not is_image_completely_black(image)
    if image_out_callback is not None:
        image_out_callback(_generate_idx, image, params, passed_safety_check)


def generate(params: TextImageParams):
    global \
        _last_model_name, \
        _last_mode, \
        _basic_model_pipe, \
        _ext_model_pipe, \
        _realESRGANer, \
        _stop_generate, \
        _generating, \
        _preview_enabled

    try:
        stop_generate()
        torch.xpu.set_device(params.device)
        # model_config.device = f"xpu:{params.device}"
        if _last_model_name != params.model_name:
            # hange model dispose basic model
            if _basic_model_pipe is not None:
                dispose_basic_model()

        _preview_enabled = params.image_preview

        _stop_generate = False

        _generating = True

        print("receive params", vars(params))
        if params.mode == 1:
            upscale(params)
        elif params.mode == 2:
            image_to_image(params)
        elif params.mode == 3:
            inpaint(params)
        elif params.mode == 4:
            outpaint(params)
        else:
            text_to_image(params)
        _last_mode = params.mode

        torch.xpu.empty_cache()
    finally:
        _generating = False


# endregion


def dispose_basic_model():
    global \
        _basic_model_pipe, \
        _ext_model_pipe, \
        _taesd_vae, \
        _last_lora, \
        _last_scheduler, \
        _last_mode, \
        _last_model_name

    stop_generate()

    if _ext_model_pipe is not None:
        del _ext_model_pipe
        _ext_model_pipe = None
    if _basic_model_pipe is not None:
        for key in _basic_model_pipe.components:
            del _basic_model_pipe.components[key]
        del _basic_model_pipe
        _basic_model_pipe = None
    if _taesd_vae is not None:
        del _taesd_vae
        _taesd_vae = None

    _last_lora = "None"
    _last_scheduler = "None"
    _last_model_name = None
    _last_mode = None

    gc.collect()
    torch.xpu.empty_cache()


def dispose_ext_model():
    global _ext_model_pipe
    del _ext_model_pipe
    _ext_model_pipe = None
    gc.collect()
    torch.xpu.empty_cache()


def dispose():
    global _realESRGANer, _preview_thread
    if _realESRGANer is not None:
        del _realESRGANer
        _realESRGANer = None
    dispose_basic_model()


def stop_generate():
    global _stop_generate, _generating, _stop_event
    if _generating:
        _stop_generate = True
        _stop_event.clear()
        _stop_event.wait()
        _generating = False
        _stop_generate = False


def assert_stop_generate():
    global _stop_generate, _stop_event
    if _stop_generate:
        _stop_event.set()
        raise StopGenerateException()


def clear_xpu_cache():
    torch.xpu.empty_cache()
