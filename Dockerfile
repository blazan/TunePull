FROM denoland/deno:bin-2.9.8 AS deno

FROM python:3.12-slim

# Recent yt-dlp solves YouTube's signature/n challenges with a JavaScript runtime
# plus the EJS solver. Without them it warns "No supported JavaScript runtime could
# be found" and silently drops formats, which surfaces as random download failures.
# The binary is copied from the official multi-arch image, so there is no curl | sh.
COPY --from=deno /deno /usr/local/bin/deno

# ffmpeg does the MP3 encoding; yt-dlp is installed via pip so it stays easy to update.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN pip install --no-cache-dir --upgrade yt-dlp yt-dlp-ejs

WORKDIR /app

# Run as a non-root user; the job temp dirs live under /tmp.
RUN useradd --create-home --uid 10001 appuser
COPY --chown=appuser:appuser server/server.py /app/server.py
USER appuser

EXPOSE 8756

# /health needs the token, so probe the port instead — works with auth enabled.
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
    CMD python -c "import socket; socket.create_connection(('127.0.0.1', 8756), 3).close()" || exit 1

# 0.0.0.0 is required so the port is reachable from outside the container.
# The token is required by default; pass --no-auth to disable it (not recommended
# when the port is exposed to a network).
# -u keeps stdout unbuffered so the startup banner shows up in `docker logs`.
ENTRYPOINT ["python", "-u", "/app/server.py", "--host", "0.0.0.0", "--port", "8756"]
