FROM ghcr.io/osgeo/gdal:ubuntu-small-3.8.4

# gdal2tiles needs numpy
RUN python3 -c "import numpy" 2>/dev/null || \
    (apt-get update && apt-get install -y --no-install-recommends python3-numpy \
     && rm -rf /var/lib/apt/lists/*)

WORKDIR /app
COPY pipeline.py .
COPY viewer/ viewer/

RUN python3 -c "from osgeo_utils import gdal2tiles"

EXPOSE 8080
CMD ["sh", "-c", "python3 pipeline.py && python3 -m http.server 8080 --directory /app/output"]
