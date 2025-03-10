from langchain_community.embeddings import OpenVINOBgeEmbeddings


class OpenVINOEmbeddingModel:
    def __init__(self):
        self.embedding_model_id = "default_embedding_model"
        self.embedding_device = "CPU"
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

        self.embedding = OpenVINOBgeEmbeddings(
            model_name_or_path=self.embedding_model_id,
            model_kwargs=embedding_model_kwargs,
            encode_kwargs=encode_kwargs,
        )
        self.embedding.ov_model.compile()

    def get_embedding(self, text: str):
        return self.embedding.embed_query(text)




