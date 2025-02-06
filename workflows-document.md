# AI Playground Workflows Documentation

## Structure of Workflow JSON Files

| Tag | Description|
| :---- | :---- |
| “name” |**Required**: Yes<br>**Value Type**: Text string in quotes <br>**Description**: name of workflow as it should show in the workflow dropdown|
| “displayPriority” |  **Required**: No <br>**Value Type**: Integer <br>**Description**: If present will provide an order hierarchy for the workflow dropdown. Higher number is higher in the list</li></ui>  |
| “tags” |  **Required**: No <br>**Value Type**: String Array, <br>**Description:** List of tags in quotes separated by commas, these are listed in the Workflow list</li></ui> |
| “backend” | **Required**, yes set value to “comfyui” |
| “comfyuiRequirements” | **Required**, yes, this is where everything for the workflow goes. And the second to last bracket of the script |
| “customNodes”  | **Required**: yes if nothing leave as empty brackets \[ \] <br>**Description**: A list of required custom nodes for this workflow <br>**Syntax**: \[“host/nodename@node-ID”\]<br> ie\["city96/ComfyUI-GGUF@65a7c895bb0ac9547ba2f89d55fbdb609aa2bfe7"\] |
| “requiredModels” | **Required**: yes, if nothing leave as empty brackets \[ \] <br>**Description**: A list of required models for this workflow <br>**Syntax** <br>“**type**”: text string in quotes for the folder location for the model <br>ie “unet” <br>“**model**”: text string in quotes of the models huggingface id <br> ie "city96/FLUX.1-schnell-gguf/flux1-schnell-Q4\_K\_S.gguf" |
| “requirements” | **Required**: yes if nothing leave as empty brackets \[ \] Type:  Text string in quotes  Description: A tag that if used can trigger other information in the UI <br>**Allowed Values:** “high-vram” |
| “inputs”  | **Required**: yes if nothing leave as empty brackets \[ \] <br>**Description**: Add inputs to settings menu, such as number sliders, text strings, load image etc. <br>**Syntax**: <br>"_nodeTitle_": the name of the node this input will influence <br>"nodeInput": the name of the field in that node this input will influence <br>"_type_": the type of input ie: number, string, image <br>"_label_": text string for the label of this input in the settings menu <br>"_defaultValue_": the default value for this node, which will need to match the value typeIf the input is an image use the value found at the bottom of this document <br>**Number Syntax**: additional values for a number input <br>"_step_":  a float or integer value that will be the increment values between the minimum and maximum value <br>"_min_": the lowest value this number can be <br>"_max_": the highest value this number can be |
| “outputs” | **Required**: yes if nothing leave as empty brackets \[ \] <br>**Type**:  Text string in quotes  <br>**Description**: A tag that if used can trigger other information in the UI <br>**Allowed Values**: “high-vram” |
| “defaultSettings" | **Required**: yes <br>**Description**: data from ComfyUI that will come back to the AI Playground UI Syntax “name”: text string of the data being used for output <br> ie “output\_image” “type”: type of data <br>ie: “image”  |
| "displayedSettings" | **Required**: yes if no default values need leave as empty brackets \[ \] <br>**Description**: Input types you’d like to show in settings, but are not modifiable such as: “resolution”, “seed”, prompt” “inferenceSteps”, “batchSize, “cfg”, “prompt”, “negativePrompt” <br>**Syntax**: “inputField” ie "scheduler", "cfg"  |
| "modifiableSettings"  | **Required**: yes if no default values need leave as empty brackets \[ \] <br>**Description**: Input types you’d like the user to adjust: “resolution”, “seed”, prompt” “inferenceSteps”, “batchSize, “cfg”, “negativePrompt” <br>**Syntax**: “inputField” ie "inferenceSteps", "seed" |
| "comfyUiApiWorkflow": | **Required**: yes <br>**Description**: This section should be a copu and paste of the API export of the workflow created in ComfyUI. 

## Instructions

**Creating a New An AI Playground Workflow**
* Go to the Workflows folder under AI Playground/resources
* Select an existing workflow and make a copy of it
* Change the name of the workflow keeping the .json at the end
* Open the workflow in a text or code editor and edit the workflow name and other tags for your new workflow needs. Follow the above guide for editing the workflow for your new workflow
* In AI Playground, refesh the list of workflows to see your workflow in the list - See first row in table above
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
  * “image”,

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
* “cfg”  
* “sampler”  
* “scheduler”  
* “batchSize”  
* “imagePreview”

  
