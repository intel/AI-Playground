from langchain_community.embeddings import LlamaCppEmbeddings

class LlamaCppEmbeddingModel:
    def __init__(self):
        self.embedding_model_path = "bge-large-en-v1.5-q4_k_m.gguf"

        self.embedding = LlamaCppEmbeddings(
            model_path=self.embedding_model_path
        )

    def embed_query(self, text: str):
        return self.embedding.embed_query(text)

    def embed_documents(self, texts: list[str]):
        return self.embedding.embed_documents(texts)
