from langchain_community.embeddings import OpenVINOEmbeddings


class OpenVINOEmbeddingModel:
    def __init__(self):
        model_name = "BAAI/bge-large-en-v1.5"
        model_kwargs = {'device': 'GPU'}
        encode_kwargs = {
            "mean_pooling": True,
            "normalize_embeddings": True,
            "batch_size": 4,
        }
        self.embedding = OpenVINOEmbeddings(
            model_name_or_path=model_name,
            model_kwargs=model_kwargs,
            encode_kwargs=encode_kwargs
        )
        self.embedding.ov_model.compile()
        self.embedding_model_path = model_name

    def embed_query(self, text: str):
        return self.embedding.embed_query(text)

    def embed_documents(self, texts: list[str]):
        return self.embedding.embed_documents(texts)




