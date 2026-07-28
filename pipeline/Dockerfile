FROM python:3.11.15-slim-bookworm

ARG PZMAP2DZI_COMMIT=d682149cf805b556960cae71487c61cfd4683947

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        build-essential \
        ca-certificates \
        git \
        libx11-6 \
        libxext6 \
        libxtst6 \
        time \
    && rm -rf /var/lib/apt/lists/*

RUN git clone https://github.com/cff29546/pzmap2dzi.git /opt/pzmap2dzi \
    && git -C /opt/pzmap2dzi checkout --detach "${PZMAP2DZI_COMMIT}" \
    && python -m pip install --no-cache-dir --upgrade pip \
    && python -m pip install --no-cache-dir -r /opt/pzmap2dzi/requirements.txt

COPY pipeline/config/spike.yaml /opt/pzmap2dzi/conf/spike.yaml
COPY pipeline/scripts/validate_spike.py /opt/spike/validate_spike.py
COPY --chmod=0755 pipeline/scripts/spike_render.sh /usr/local/bin/spike-render

WORKDIR /opt/pzmap2dzi

ENTRYPOINT ["/usr/local/bin/spike-render"]
