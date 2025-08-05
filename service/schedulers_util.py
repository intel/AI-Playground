import diffusers

scheduler_map = {
    "DPM++ 2M": {"class_name": "DPMSolverMultistepScheduler", "kwargs": {}},
    "DPM++ 2M Karras": {
        "class_name": "DPMSolverMultistepScheduler",
        "kwargs": {"use_karras_sigmas": True, "final_sigmas_type": "sigma_min"},
    },
    "DPM++ SDE": {"class_name": "DPMSolverSinglestepScheduler", "kwargs": {}},
    "DPM++ SDE Karras": {
        "class_name": "DPMSolverSinglestepScheduler",
        "kwargs": {"use_karras_sigmas": True, "final_sigmas_type": "sigma_min"},
    },
    "DPM2": {"class_name": "KDPM2DiscreteScheduler", "kwargs": {}},
    "DPM2 Karras": {
        "class_name": "KDPM2DiscreteScheduler",
        "kwargs": {"use_karras_sigmas": True},
    },
    "DPM2 a": {"class_name": "KDPM2AncestralDiscreteScheduler", "kwargs": {}},
    "DPM2 a Karras": {
        "class_name": "KDPM2AncestralDiscreteScheduler",
        "kwargs": {"use_karras_sigmas": True},
    },
    "Euler": {"class_name": "EulerDiscreteScheduler", "kwargs": {}},
    "Euler a": {"class_name": "EulerAncestralDiscreteScheduler", "kwargs": {}},
    "Heun": {"class_name": "HeunDiscreteScheduler", "kwargs": {}},
    "LMS": {"class_name": "LMSDiscreteScheduler", "kwargs": {}},
    "LMS Karras": {
        "class_name": "LMSDiscreteScheduler",
        "kwargs": {"use_karras_sigmas": True},
    },
    "DEIS": {"class_name": "DEISMultistepScheduler", "kwargs": {}},
    "UniPC": {"class_name": "UniPCMultistepScheduler", "kwargs": {}},
    "DDIM": {"class_name": "DDIMScheduler", "kwargs": {}},
    "DDPM": {"class_name": "DDPMScheduler", "kwargs": {}},
    "EDM Euler": {"class_name": "EDMEulerScheduler", "kwargs": {}},
    "PNDM": {"class_name": "PNDMScheduler", "kwargs": {}},
    "LCM": {
        "class_name": "LCMScheduler",
        "kwargs": {
            "beta_start": 0.00085,
            "beta_end": 0.012,
            "beta_schedule": "scaled_linear",
            "set_alpha_to_one": True,
            "rescale_betas_zero_snr": False,
            "thresholding": False,
        },
    },
}

schedulers = list(scheduler_map.keys())


def set_scheduler(pipe: diffusers.DiffusionPipeline, name: str):
    print("---------------------debug ", name)
    scheduler_cfg = scheduler_map.get(name)
    if name == "None":
        if hasattr(pipe.scheduler, "scheduler_config"):
            default_class_name = pipe.scheduler.scheduler_config["_class_name"]
        else:
            default_class_name = pipe.scheduler.config["_class_name"]
        if default_class_name == type(pipe.scheduler).__name__:
            return
        else:
            scheduler_class = getattr(diffusers, default_class_name)
    elif scheduler_cfg is None:
        raise Exception(f'unkown scheduler name "{name}"')
    else:
        scheduler_class = getattr(diffusers, scheduler_cfg["class_name"])
    print(f"load scheduler {name}")
    pipe.scheduler = scheduler_class.from_config(
        pipe.scheduler.config, **scheduler_cfg["kwargs"]
    )
