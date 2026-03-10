FROM pgvector/pgvector:pg18

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        build-essential \
        ca-certificates \
        git \
        postgresql-server-dev-18 \
    && git clone https://github.com/pgbigm/pg_bigm.git /tmp/pg_bigm \
    && cd /tmp/pg_bigm \
    && make USE_PGXS=1 \
    && make USE_PGXS=1 install \
    && cd / \
    && rm -rf /tmp/pg_bigm \
    && apt-get purge -y build-essential git postgresql-server-dev-18 \
    && apt-get autoremove -y \
    && rm -rf /var/lib/apt/lists/*
