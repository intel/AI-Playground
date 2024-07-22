# Load model directly
from threading import Thread
import time
import traceback
import torch
from transformers import pipeline,PreTrainedModel,TextIteratorStreamer
import intel_extension_for_pytorch as ipex

def stream_chat_generate(model:PreTrainedModel, args:dict):
    
    try:
        print("generate start")
        start = time.time()
        model.generate(**args)
        end = time.time()
        print(f"generate finish. cost {end-start}s")
    except Exception:
        traceback.print_exc()

if __name__ == "__main__":
    pipe = pipeline("text-generation", model="microsoft/Phi-3-mini-4k-instruct", torch_dtype=torch.bfloat16)

    # We use the tokenizer's chat template to format each message - see https://huggingface.co/docs/transformers/main/en/chat_templating
    messages = [
        {
            "role": "system",
            "content": "You are a friendly chatbot who always responds in the style of a pirate",
        },
        {"role": "user", "content": "How many helicopters can a human eat in one sitting?"},
    ]
    pipe.model.eval()
    pipe.model.to("xpu")
    model = ipex.optimize(pipe.model, dtype=torch.bfloat16)
    prompt = pipe.tokenizer.apply_chat_template(messages, tokenize=False, add_generation_prompt=True, return_tensors="pt")
    encoding = pipe.tokenizer.encode_plus(prompt, return_tensors="pt").to("xpu")
    tensor : torch.Tensor = encoding.get("input_ids")
    streamer = TextIteratorStreamer(
        pipe.tokenizer,
        skip_prompt=False,  # skip prompt in the generated tokens
        skip_special_tokens=True,
    )
    generate_kwargs = dict(
        inputs=tensor,
        streamer=streamer,
        num_beams=1,
        do_sample=True,
        max_new_tokens=256,
        temperature=0.7, 
        top_k=50, 
        top_p=0.95
    )
    torch.xpu.synchronize()
    Thread(target=stream_chat_generate, args=(pipe.model,generate_kwargs)).start()
    
    for stream_output in streamer:
        print(stream_output, end="")
    print()


# if __name__ == "__main__":
#     from transformers import AutoTokenizer, AutoModelForCausalLM

#     start = time.time()
#     model_path = os.path.abspath("microsoft/Phi-3-mini-4k-instruct")
#     model : PreTrainedModel | TFPreTrainedModel = AutoModelForCausalLM.from_pretrained(model_path)
#     model = model.eval()
#     end = time.time()
#     print(f"load model cost: {(end-start)}s")
#     model = model.to('xpu')
#     start = time.time()
#     model = ipex.optimize(model, dtype=torch.int8)
#     end = time.time()
#     print(f"ipex.optimize cost: {(end-start)}s")
#     tokenizer = AutoTokenizer.from_pretrained(model_path)
#     messages = [
#         {
#             "role": "system",
#             "content": "You are a friendly chatbot who always responds in the style of a pirate",
#         },
#         {"role": "user", "content": "How many helicopters can a human eat in one sitting?"},
#     ]
#     prompt = tokenizer.apply_chat_template(messages, tokenize=False, add_generation_prompt=True)
#     encoding = tokenizer.encode_plus(prompt,return_tensors="pt").to("xpu")
#     tensor : torch.Tensor = encoding.get("input_ids")
#     with torch.no_grad():
#         with torch.xpu.amp.autocast(enabled=True, dtype=torch.bfloat16, cache_enabled=True):
#             start = time.time()
#             outputs = model.generate(inputs=tensor, max_new_tokens=256, do_sample=True, temperature=0.7, top_k=50, top_p=0.95)
#             end = time.time()
#             print(f"generate cost: {(end-start)}s")
#             generated_text = tokenizer.decode(outputs[0], skip_special_tokens=True)
#             print(generated_text)