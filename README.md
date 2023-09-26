This repo contains the processing API which the cesium interface relies on. There are various endpoints but most important of them are /download and /crop. /download allows conversion and download of source files in various other formats, and /crop is responsible for cropping functions of the front-end using pdal. Other endpoints such as /eptNumPoints, /eptFileSize, and /wkt2geojson help with other smaller tasks of the frontend. Together, all of these form the processing api.
