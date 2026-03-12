from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    DATABASE_URL: str = "postgresql+asyncpg://las:las@localhost:5432/las"
    REDIS_URL: str = "redis://localhost:6379/0"

    JWT_SECRET: str = "change-me-in-production"
    JWT_ALGORITHM: str = "HS256"
    ACCESS_TOKEN_EXPIRE_MINUTES: int = 480  # 8 hours
    REFRESH_TOKEN_EXPIRE_DAYS: int = 7

    LLM_URL: str = "http://localhost:8080"
    EMBED_URL: str = "http://localhost:8081"

    STORAGE_PATH: str = "/app/storage"

    model_config = {"env_file": ".env", "extra": "ignore"}


settings = Settings()
