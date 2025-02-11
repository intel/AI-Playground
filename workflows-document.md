# AI Playground Workflows Documentation

## Structure of Workflow JSON Files

| Tag | Description|
| :---- | :---- |
| “name” |**Required**: Yes<br>**Value Type**: Text string in quotes <br>**Description**: name of workflow as it should show in the workflow dropdown|
| “displayPriority” |  **Required**: No <br>**Value Type**: Integer <br>**Description**: If present will provide an order hierarchy for the workflow dropdown. Higher number is higher in the list</li></ui>  |
| “tags” |  **Required**: Yes, if no tags leave as empty brackets \[ \] <br>**Value Type**: String Array, <br>**Description:** List of tags in quotes separated by commas, these are listed in the Workflow list</li></ui> |
| “backend” | **Required**: Yes, set value to “comfyui” |
| “comfyuiRequirements” | **Required**: Yes, this is where the dependecies for models and nodes are defined |
| “customNodes”  | **Required**: Yes, if no custom nodes leave as empty brackets \[ \] <br>**Description**: A list of required custom nodes for this workflow <br>**Syntax**: \[“githubOwner/repoName@commitHash”\]<br> ie\["city96/ComfyUI-GGUF@65a7c895bb0ac9547ba2f89d55fbdb609aa2bfe7"\] |
| “requiredModels” | **Required**: No <br>**Description**: A list of required models for this workflow <br>**Syntax** <br>“**type**”: text string in quotes for the folder location for the model <br>ie “unet” <br>“**model**”: text string in quotes of the models huggingface id <br> ie "city96/FLUX.1-schnell-gguf/flux1-schnell-Q4\_K\_S.gguf" |
| “requirements” | **Required**: Yes, if nothing leave as empty brackets \[ \] <br>**Type**:  Text string in quotes  <br>**Description**: A tag that if used can trigger other information in the UI <br>**Allowed Values:** “high-vram” |
| “inputs”  | **Required**: Yes, if nothing leave as empty brackets \[ \] <br>**Description**: Add inputs to settings menu, such as number sliders, text strings, load image etc. <br>**Syntax**: <br>"_nodeTitle_": the title of the node in ComfyUI this input will influence <br>"_nodeInput_": the name of the field in that node this input will influence <br>"_type_": the type of input ie: number, string, image <br>"_label_": text string for the label of this input in the settings menu <br>"_defaultValue_": the default value for this node, which will need to match the value type<br>If the input is an image use the value found at the bottom of this document <br>**Number Syntax**: additional values for a number input <br>"_step_":  a float or integer value that will be the increment values between the minimum and maximum value <br>"_min_": the lowest value this number can be <br>"_max_": the highest value this number can be |
| “outputs” | **Required**: Yes, leave as empty brackets \[ \]
| “defaultSettings" | **Required**: No <br>**Description**: Default values for settings when they should differ from the AIPG default <br>**Syntax**: { setting1: value, ... }, e.g. { inferenceSteps: 10 }  |
| "displayedSettings" | **Required**: Yes, if no default values need leave as empty brackets \[ \] <br>**Description**: Input types you’d like to show in settings, but are not modifiable such as: “resolution”, “seed”, prompt” “inferenceSteps”, “batchSize, “cfg”, “prompt”, “negativePrompt” <br>**Syntax**: “inputField” ie "scheduler", "cfg"  |
| "modifiableSettings"  | **Required**: Yes, if no default values need leave as empty brackets \[ \] <br>**Description**: Input types you’d like the user to adjust: “resolution”, “seed”, prompt” “inferenceSteps”, “batchSize, “cfg”, “negativePrompt” <br>**Syntax**: “inputField” ie "inferenceSteps", "seed" |
| "comfyUiApiWorkflow": | **Required**: Yes <br>**Description**: This section should be a copy and paste of the API export of the workflow created in ComfyUI. 

## Instructions

**Creating a New An AI Playground Workflow**
* Go to the Workflows folder under AI Playground/resources
* Select an existing workflow and make a copy of it
* Change the name of the workflow keeping the .json at the end
* Open the workflow in a text or code editor and edit the workflow name and other tags for your new workflow needs. Follow the above guide for editing the workflow for your new workflow
* In AI Playground, refresh the list of workflows to see your workflow in the list - See first row in table above
* Follow the next steps to edit the "comfyUiApiWorkflow" section

**Adding API data intro an AI Playground Workflow JSON**

* **Paste In API Info:** 
  * After making the workflow in ComfyUI, go to Workflow Menu in ComfyUI and select Export (API).
  * Open that JSON usually saved to your downloads director.
  * Select all and copy
  * Open the AI PLayground JSON file and paste that after the colon of the "comfyUiApiWorkflow" tag. There will be one additional backet “}” at the end of what was pasted.

* **Edit Clip Nodes**: To connect the Prompt or Negative Prompt fields of AI Playground into the respective Clip nodes you’ll need to edit the positive and negative clips as follows.  Clip nodes are usuall numbered 6 and 7 and will have the class type "CLIPTextEncode",
  * Edit the clip node used for the positive prompt <br>"_meta": {"title": "CLIP Text Encode (Prompt)" } <br>To<br> "_meta": {"title": "prompt" }
  * Edit the clip node used for the negative  prompt <br>"_meta": {"title": "CLIP Text Encode (Prompt)" } <br>To<br> "_meta": {"title": "negativePrompt" }

**Adding Input Fields:**  Input Fields allows you to add inputs to the AI Playground Settings UI to influence parameters of the workflow in ComfyUI

* **Allowable Input Fields Types**: Field names and value types  
  * “number”, float to 1 decimal or integer (20)  
  * “string”, text in quotes up to X characters  
  * “image”, use this value as default: 

* **Batch Size Example**: Adding an input slider to a workflow that has an "Empty Latent Image" node will allow for batch\_Size to be set by the user.  
  {  
        "nodeTitle": "Empty Latent Image",  
        "nodeInput": "batch\_size",  
        "type": "number",  
        "label": "Batch Size",  
        "defaultValue": 1,  
        "step": 1,  
        "min": 1,  
        "max": 4  
      }

  **Example Explanation:** the batch\_Size field determines how many images will be generated at the same time. In AI Playground this value is set to “1” by default. The code above adds a number slider to the settings menu with an input range from 1 to 4\. In the example image below, the batch\_size is set to 2 with a image generation number of 4, generating 8 total images.

    ![image](https://github.com/user-attachments/assets/b5fb5c88-ca86-457d-8496-d182a4fcfea8)



**Allowed AI Playground Settings Names** for “displayedSettings” or “modifiableSettings”

* “resolution”,   
* “inferenceSteps”  
* “seed”  
* “guidanceScale”  
* “sampler”  
* “scheduler”  
* “batchSize”  
* “imagePreview”

Input image default value:
"defaultValue": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAgAAAAIACAYAAAD0eNT6AAAZMElEQVR4nO3daXMTZ9aA4aPFFl6wDdgQ2xAChAEya/7/T0hmMkvlTZFJUiSYxYDBOCAv2t4PlKmEAWy1JUutc11fZoqopce2pL776a3y9ddf9wIASKU66gEAAKdPAABAQgIAABISAACQkAAAgIQEAAAkJAAAICEBAAAJCQAASEgAAEBCAgAAEhIAAJCQAACAhAQAACQkAAAgIQEAAAkJAABISAAAQEICAAASEgAAkJAAAICEBAAAJCQAACAhAQAACQkAAEhIAABAQgIAABISAACQkAAAgIQEAAAkJAAAICEBAAAJCQAASEgAAEBCAgAAEhIAAJCQAACAhAQAACQkAAAgIQEAAAkJAABISAAAQEICAAASEgAAkJAAAICEBAAAJCQAACAhAQAACQkAAEhIAABAQgIAABISAACQkAAAgIQEAAAkJAAAICEBAAAJCQAASEgAAEBCAgAAEhIAAJCQAACAhAQAACQkAAAgIQEAAAkJAABISAAAQEICAAASEgAAkJAAAICEBAAAJCQAACAhAQAACQkAAEhIAABAQgIAABISAACQkAAAgIQEAAAkJAAAICEBAAAJCQAASEgAAEBCAgAAEhIAAJCQAACAhAQAACQkAAAgIQEAAAkJAABISAAAQEICAAASEgAAkJAAAICEBAAAJCQAACAhAQAACQkAAEhIAABAQgIAABISAACQkAAAgIQEAAAkJAAAICEBAAAJCQAASEgAAEBCAgAAEhIAAJCQAACAhAQAACQkAAAgIQEAAAkJAABISAAAQEICAAASEgAAkJAAAICEBAAAJCQAACAhAQAACQkAAEhIAABAQgIAABISAACQkAAAgIQEAAAkJAAAICEBAAAJCQAASEgAAEBCAgAAEhIAAJCQAACAhAQAACQkAAAgIQEAAAkJAABISAAAQEICAAASEgAAkJAAAICEBAAAJCQAACAhAQAACQkAAEhIAABAQgIAABISAACQkAAAgIQEAAAkJAAAICEBAAAJCQAASEgAAEBCAgAAEhIAAJCQAACAhAQAACQkAAAgIQEAAAkJAABISAAAQEICAAASEgAAkJAAAICEBAAAJCQAACAhAQAACQkAAEhIAABAQgIAABISAACQkAAAgIQEAAAkJAAAICEBAAAJCQAASEgAAEBCAgAAEhIAAJCQAACAhAQAACQkAAAgIQEAAAkJAABISAAAQEICAAASEgAAkJAAAICEBAAAJCQAACAhAQAACQkAAEhIAABAQgIAABISAACQkAAAgIQEAAAkJAAAICEBAAAJCQAASEgAAEBCAgAAEhIAAJCQAACAhAQAACQkAAAgIQEAAAkJAABISAAAQEICAAASEgAAkJAAAICEBAAAJCQAACAhAQAACdVHPQCgHA4ODmJ7ezt2dnbi4OAgWq1WtNvtaLVa0el0YmpqKur1ekxNTcXU1FScOXMmFhcXY3FxMapV2xowbgRAid27dy82Njb6Xm59fT2uXbtW6DW//vrr2Nvb62uZa9euxfr6+pGP++qrr2J/f7/QuD6kVqu9XSkd/u/8/HwsLi7G/Pz8QF+r6Pi//PLLmJubG+hYBqXZbMajR49ie3s7dnd3P/rYg4ODODg4+N2/bWxsRKVSiYWFhTh37lysrq5GrVYb5pA/6OnTp3H37t2BPueNGzdidXV1oM85jM9BRESlUol6vf67z0Oj0XgbaVNTUwN/TcabAGCidTqd6HQ6v/tCffr0aURE1Ov1WFhYiIsXL8by8vKohjiWdnd345dffnn7uzqJXq8XL1++jJcvX8bGxkasr6/H2traqYfAUQFTRLPZHPhzDkuv14tWqxWtVut3v4tHjx5FRMTs7OzbSDtz5syohskpEgCk1W634/nz5/H8+fOYnZ2NK1euxMrKyqiHNVLdbjd++umnePz48VCev91ux88//xwPHjyI69evx8WLF4fyOu8zjJX1MKJiVJrNZjSbzXj48GFcvHgxrly5IgQmnB1zEG++/O7evRv/+Mc/JupLvR+tViv+85//DG3l/1vtdju+//77uHfv3tBf69AwAqBMMwDH1ev1YnNzM/7+97/Hzz//POrhMEQCAH6j2WzGv/71r9je3h71UE7V69ev45///Gf8+uuvp/q6Gxsb8d1330W32x3q6/R6vb6PXTmOg4ODaLfbA3/ecdDr9eL+/fun8vdhNAQAvKPdbse3334bm5ubox7KqWi1WvHtt98O5cCz49ja2or//ve/Q32N/f39oa3EJn3GaGtrK/79739Hq9Ua9VAYMAEA79Hr9eKHH3449S3iUfj+++//5+j90/b06dOhBtcwp+oncTfAu169ejXwMygYPQEAH9Dr9eLu3bsT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V68KPdfh3QfPnTsXq6ur9glOsNnZ2bh9+3Y0m8149OhRbG9vFz54rVKpxNmzZ+P8+fPxySefnDgYx+EMgEOzs7Oxs7PT93KjOBCwUqm8vRri4exFo9GIhYWFWFxcHPmBoJy+ytdff13+61LSl3a7Hdvb2/Hy5cvY39+PdrsdrVYrWq1WdDqd331BHH5JLC4uxuLioq39xPb39+Ply5exs7MTBwcHb98z7Xb77fvm8D1Tr9fjzJkzsbS0FAsLC/YhwxgSAACQkEO2ASAhAQAACQkAAEhIAABAQgIAABISAACQkAAAgIQEAAAkJAAAICEBAAAJCQAASEgAAEBCAgAAEhIAAJCQAACAhAQAACQkAAAgIQEAAAkJAABISAAAQEICAAASEgAAkJAAAICEBAAAJCQAACAhAQAACQkAAEhIAABAQgIAABISAACQkAAAgIQEAAAkJAAAICEBAAAJCQAASEgAAEBCAgAAEhIAAJCQAACAhAQAACQkAAAgIQEAAAkJAABISAAAQEICAAASEgAAkJAAAICEBAAAJCQAACAhAQAACQkAAEhIAABAQgIAABISAACQkAAAgIQEAAAkJAAAICEBAAAJCQAASEgAAEBCAgAAEhIAAJCQAACAhAQAACQkAAAgIQEAAAkJAABISAAAQEICAAASEgAAkJAAAICEBAAAJCQAACAhAQAACQkAAEhIAABAQgIAABISAACQkAAAgIQEAAAkJAAAICEBAAAJCQAASEgAAEBCAgAAEhIAAJCQAACAhAQAACQkAAAgIQEAAAkJAABISAAAQEICAAASEgAAkJAAAICEBAAAJCQAACAhAQAACQkAAEhIAABAQgIAABISAACQkAAAgIQEAAAkJAAAICEBAAAJCQAASEgAAEBCAgAAEhIAAJCQAACAhAQAACQkAAAgIQEAAAkJAABISAAAQEICAAASEgAAkJAAAICEBAAAJCQAACAhAQAACQkAAEhIAABAQgIAABISAACQkAAAgIQEAAAkJAAAICEBAAAJCQAASEgAAEBCAgAAEhIAAJCQAACAhAQAACQkAAAgIQEAAAkJAABISAAAQEICAAASEgAAkJAAAICEBAAAJCQAACAhAQAACQkAAEhIAABAQgIAABISAACQkAAAgIQEAAAkJAAAICEBAAAJCQAASEgAAEBCAgAAEhIAAJCQAACAhAQAACQkAAAgIQEAAAkJAABISAAAQEICAAASEgAAkJAAAICEBAAAJCQAACAhAQAACQkAAEhIAABAQgIAABISAACQkAAAgIQEAAAkJAAAICEBAAAJCQAASEgAAEBCAgAAEhIAAJCQAACAhAQAACQkAAAgIQEAAAkJAABISAAAQEICAAASEgAAkJAAAICEBAAAJCQAACAhAQAACQkAAEhIAABAQgIAABISAACQkAAAgIQEAAAkJAAAICEBAAAJ/T8r8gNH5WpNaAAAAABJRU5ErkJggg=="
