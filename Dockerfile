FROM nginx:alpine
RUN echo "<h1>Hola desde mi Pipeline Compartida AUY1104-Demian Hurtubia</h1>" > /usr/share/nginx/html/index.html
EXPOSE 80