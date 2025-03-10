from langchain_community.embeddings import OpenVINOEmbeddings


class OpenVINOEmbeddingModel:
    def __init__(self):
        self.embedding_model_id = "default_embedding_model"
        self.embedding_device = "CPU" # or "GPUT"
        self.embedding_model_configuration = {
            "mean_pooling": True,
            "normalize_embeddings": True
        }

        embedding_model_kwargs = {"device": self.embedding_device, "compile": False}
        encode_kwargs = {
            "mean_pooling": self.embedding_model_configuration["mean_pooling"],
            "normalize_embeddings": self.embedding_model_configuration["normalize_embeddings"],
            "batch_size": 4,
        }

        model_name = "sentence-transformers/all-mpnet-base-v2"
        model_kwargs = {'device': 'CPU'}
        encode_kwargs = {'normalize_embeddings': True}
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




