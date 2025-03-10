
LlamaCppEmbeddingModel

class LlamaCppEmbeddingModel:
    def __init__(self):
        self.embedding_model_path = "path_to_llama_model.gguf"

        self.embedding = LlamaCppEmbeddings(
            model_path=self.embedding_model_path
        )

    def get_embedding(self, text: str):
        return self.embedding.embed_query(text)

