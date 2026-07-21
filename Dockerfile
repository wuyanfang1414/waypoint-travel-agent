FROM python:3.12-slim
WORKDIR /app
COPY . .
EXPOSE 8877
CMD ["python", "server.py", "--host", "0.0.0.0", "--port", "8877"]

