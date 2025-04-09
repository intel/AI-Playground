## How to port models to OpenVINO format and add to AI Playground manually. 

This document will walk you through the steps to port a model to the IR format for use in AI Playground using OpenVINO. This document is in draft (WIP)

1.	Make sure, that AI Playground is installed on your PC.
2.	Create a folder in AI Playground 
<Path-to-AI Playground>\AI Playground\resources\service\models\llm\openvino\OpenVINO---<ModelName> 

For example, to add Phi-4-mini-instruct model with int4 quantization you can create such folder.
<Path-to-AI Playground>\AI Playground\resources\service\models\llm\openvino\OpenVINO---Phi-4-mini-instruct-int4-ov
 ![image](https://github.com/user-attachments/assets/247f6e2c-380c-4d8a-99cf-b5de69ad2d4a)

3.	To be used in AI Playground, the model must be converted to OpenVINO IR format first. The most convenient approach to convert the models is by using the corresponding OpenVINO notebook. Please follow the steps below to prepare OpenVINO model.
- a.	Install OpenVINO Notebooks on your PC following these instructions 
https://github.com/openvinotoolkit/openvino_notebooks/tree/latest?tab=readme-ov-file#-installation-guide

- b.	Convert a popular model to the OpenVINO IR format using this notebook
https://github.com/openvinotoolkit/openvino_notebooks/blob/latest/notebooks/llm-chatbot/llm-chatbot-generate-api.ipynb
<br>In the notebook you can select any model you prefer (for example, phi-4-mini-instruct) and type of compression. The model list is maintained by Intel and represents a list of popular chat models. You can alternatively follow the instructions in section 2d using Command Line to port models outside of this list.
![image](https://github.com/user-attachments/assets/933a1424-d38d-4ad2-af97-e0a8eb16eacb)
<br><br>You can execute the notebook up to cells 7 and 8. As a result, you will get the converted model in IR format <br>![image](https://github.com/user-attachments/assets/aa941a49-46fe-4d3f-aebf-c4c629347ae5)


- c.	Copy IR files to the corresponding AI Playground folder 
 ![image](https://github.com/user-attachments/assets/e8f62017-6f3a-4ec3-b67e-06a83ee7233d)
- d. Model conversion without OpenVINO notebook: 
Alternatively, models can be converted to OpenVINO IR format directly from command line using optimum-cli. More information about this tool can be found here https://huggingface.co/docs/optimum/en/intel/openvino/export Please refer also to usage samples in OpenVINO GenAI Quick-start Guide  
https://docs.openvino.ai/2024/_static/download/GenAI_Quick_Start_Guide.pdf 

4.	New model is available in AI Playground  
 ![image](https://github.com/user-attachments/assets/83ce8ea1-4f02-442b-b640-da30e1c92e4f)

