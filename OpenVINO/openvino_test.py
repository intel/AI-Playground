import requests


url = "http://127.0.0.1:29000/api/llm/chat"
params = {
  "prompt": [{"question": "Your name is Luca", "answer": "My name is Luca."}, {"question": "What is your name?"}],
  "device": "",
  "enable_rag": False,
  "model_repo_id": "meta-llama-3.1-8b-instruct-q5_k_m.gguf",
}
response = requests.post(url, json=params, stream=True)
# Check if the response status code is 200 (OK)
response.raise_for_status()
e = 1
# Iterate over the response lines
for line in response.iter_lines():
    e += 1
    if line:
        # Decode the line (assuming UTF-8 encoding)
        decoded_line = line.decode('utf-8')

        # SSE events typically start with "data: "
        if decoded_line.startswith("data:"):
            # Extract the data part
            data = decoded_line[len("data:"):]
            print(data)  # Process the data as needed