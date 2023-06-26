const express = require("express");
const app = express();
const formidable = require('formidable');
var AWS = require('aws-sdk');
var fs = require("fs");
var https = require("https");
var http = require("http");
const os = require('os');
const Cesium = require('cesium');
const archiver = require('archiver');
const stream = require('stream');
const { exec, execSync } = require('child_process');
const { v4: uuidv4 } = require('uuid');
const fetch = (...args) =>import('node-fetch').then(({ default: fetch }) => fetch(...args));
const { AbortController } = require("node-abort-controller");
const kill = require('tree-kill');
const FormData = require('form-data');

// app.use(compression());
app.use(function (req, res, next) {
  // res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Origin", req.headers.origin || "*");
  res.header(
    "Access-Control-Allow-Headers",
    "Origin, X-Requested-With, Content-Type, Accept"
  );
  next();
});

var bucket = "appf-anu";
//to determine whether to pass auth cookies for download
const trustedServers = ["https://asdc.cloud.edu.au/", "https://dev.asdc.cloud.edu.au/"]

AWS.config.update({
  credentials: new AWS.Credentials({
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
  })
});

const s3 = new AWS.S3()

const path = require('path');

async function uploadLogFile(id) {
  var uploadLog = new AWS.S3.ManagedUpload({
    params: { Bucket: bucket, Key: `Cesium/Uploads/${id}/log.txt`, Body: fs.createReadStream(path.join(os.tmpdir(), id.toString(), 'log.txt')), ACL: 'public-read' }
  });

  await uploadLog.promise().then(
    function (data) {
      console.log("Uploaded log file");
    },
    function (err) {
      console.log("There was an error uploading log file: ", err.message);
    }
  );
}

function updateAsset(datasets, id, index, date, originalFilename, dataID) {
  return new Promise(function (resolve, reject) {
    var tileset = new Cesium.Cesium3DTileset({
      url: `https://appf-anu.s3.ap-southeast-2.amazonaws.com/Cesium/Uploads/${id}/${index}/ept/ept-tileset/tileset.json`
    });

    tileset.readyPromise.then((tileset) => {
      var carto = Cesium.Cartographic.fromCartesian(tileset.boundingSphere.center);

      datasets.push({
        id: dataID,
        date: date,
        type: "PointCloud",
        url: `https://appf-anu.s3.ap-southeast-2.amazonaws.com/Cesium/Uploads/${id}/${index}/ept/ept-tileset/tileset.json`,
        position: {
          lng: carto.longitude * Cesium.Math.DEGREES_PER_RADIAN,
          lat: carto.latitude * Cesium.Math.DEGREES_PER_RADIAN,
          height: carto.height
        },
        boundingSphereRadius: tileset.boundingSphere.radius,
        source: {
          url: `s3://appf-anu/Cesium/Uploads/${id}/${index}/${originalFilename}`
        }
      });

      tileset = tileset && tileset.destroy();
      resolve();
    })
      .otherwise(() => {
        console.log("otherwise");
        reject();
      })
  })
}

function processFile(filepath, id, index, originalFilename, log_file) {
  return new Promise(function (resolve, reject) {
    fs.renameSync(filepath, filepath + '.laz');

    exec(`aws s3 cp \"${filepath + '.laz'}\" \"s3://appf-anu/Cesium/Uploads/${id}/${index}/${originalFilename}\"`, (error, stdout, stderr) => {
      if (error) {
        console.error(`exec error: ${error}`);
        log_file.write(`exec error: ${error}`);
        reject();
        return;
      }
      console.log(`stdout: ${stdout}`);
      console.error(`stderr: ${stderr}`);
      log_file.write(`stdout: ${stdout}`);
      log_file.write(`stderr: ${stderr}`);

      exec(`conda run -n entwine entwine build -i \"${filepath + '.laz'}\" -o \"${path.join(path.dirname(filepath + '.laz'), id, index.toString(), 'ept')}\"`, (error, stdout, stderr) => {
        if (error) {
          console.error(`exec error: ${error}`);
          log_file.write(`exec error: ${error}`);
          reject();
          return;
        }
        console.log(`stdout: ${stdout}`);
        console.error(`stderr: ${stderr}`);
        log_file.write(`stdout: ${stdout}`);
        log_file.write(`stderr: ${stderr}`);

        var eptFilePath = `${path.join(path.dirname(filepath + '.laz'), id, index.toString(), 'ept', 'ept.json')}`;
        var eptFile = fs.readFileSync(eptFilePath)
        var ept = JSON.parse(eptFile);
        var dimensions = "";
        ept.schema.map(_schema => {
          dimensions += _schema.name + " ";
        })

        exec(`conda run -n entwine ept tile \"${path.join(path.dirname(filepath + '.laz'), id, index.toString(), 'ept')}\" --truncate --dimensions ${dimensions}`, (error, stdout, stderr) => {
          if (error) {
            console.error(`exec error: ${error}`);
            log_file.write(`exec error: ${error}`);
            reject();
            return;
          }
          console.log(`stdout: ${stdout}`);
          console.error(`stderr: ${stderr}`);
          log_file.write(`stdout: ${stdout}`);
          log_file.write(`stderr: ${stderr}`);

          exec(`aws s3 cp \"${path.join(path.dirname(filepath + '.laz'), id, index.toString(), 'ept')}\" \"s3://appf-anu/Cesium/Uploads/${id}/${index}/ept\" --recursive --acl public-read`, (error, stdout, stderr) => {
            if (error) {
              console.error(`exec error: ${error}`);
              log_file.write(`exec error: ${error}`);
              reject();
              return;
            }
            console.log(`stdout: ${stdout}`);
            console.error(`stderr: ${stderr}`);
            log_file.write(`stdout: ${stdout}`);
            log_file.write(`stderr: ${stderr}`);

            resolve();
          });
        });
      });
    });
  });
}

function removeIntermediateFiles(files, id) {
  if (Array.isArray(files['files[]'])) {
    files['files[]'].map((file, index) => {
      var filepath = file.filepath;
      fs.rmSync(filepath + '.laz');
    })
  } else {
    var filepath = files['files[]'].filepath;
    fs.rmSync(filepath + '.laz');
  }

  fs.rmSync(path.join(os.tmpdir(), id.toString()), { recursive: true });
}

async function processFiles(files, id, fields, log_file) {
  var promises = [];

  if (Array.isArray(files['files[]'])) {
    files['files[]'].map((file, index) => {
      var filepath = file.filepath;
      index = index.toString();
      var originalFilename = file.originalFilename;

      promises.push(processFile(filepath, id, index, originalFilename, log_file));
    })
  } else {
    var filepath = files['files[]'].filepath;
    var index = 0;
    var originalFilename = files['files[]'].originalFilename;

    promises.push(processFile(filepath, id, index, originalFilename, log_file));
  }

  Promise.all(promises).then(() => {
    https.get("https://appf-anu.s3.ap-southeast-2.amazonaws.com/Cesium/index.json").on('response', function (response) {
      var body = '';
      response.on('data', function (chunk) {
        body += chunk;
      });

      response.on('end', function () {
        var indexJson = JSON.parse(body);
        indexJson.assets.map(asset => {
          if (asset.id === parseInt(id)) {
            if (!asset.data) {
              asset.data = [];
            }
            var updatePromises = [];
            if (Array.isArray(files['files[]'])) {
              files['files[]'].map((file, index) => {
                dataID = indexJson.datasets[indexJson.datasets.length - 1].id + 1;
                asset.data.push(dataID);
                updatePromises.push(updateAsset(indexJson.datasets, id, index, fields.dates[index], originalFilename, dataID));
              })
            } else {
              dataID = indexJson.datasets[indexJson.datasets.length - 1].id + 1;
              asset.data.push(dataID);
              updatePromises.push(updateAsset(indexJson.datasets, id, 0, fields.dates[0], originalFilename, dataID));
            }

            Promise.all(updatePromises).then(() => {
              asset.status = "active";

              var upload = new AWS.S3.ManagedUpload({
                params: { Bucket: bucket, Key: `Cesium/index.json`, Body: Buffer.from(JSON.stringify(indexJson, null, 4)), ACL: 'public-read' }
              });
              var promise = upload.promise();

              promise.then(
                function (data) {
                  console.log("Successfully uploaded index file with with positions and urls.");
                  log_file.write("Successfully uploaded index file with with positions and urls.");

                  log_file.end();

                  uploadLogFile(id).then(() => {
                    removeIntermediateFiles(files, id);
                  });
                },
                function (err) {
                  console.log("There was an error uploading index file with positions and urls: ", err.message);
                  log_file.write("There was an error uploading index file with positions and urls: ", err.message);

                  log_file.end();

                  uploadLogFile(id).then(() => {
                    removeIntermediateFiles(files, id);
                  });
                }
              );

              return;

            }).catch(() => {
              console.error("There was an error updating index file with positions");
              log_file.write("There was an error updating index file with positions");

              log_file.end();

              indexJson.assets.map(asset => {
                if (asset.id === parseInt(id)) {
                  asset.status = "failed";
                  return;
                }
              })

              var upload = new AWS.S3.ManagedUpload({
                params: { Bucket: bucket, Key: `Cesium/index.json`, Body: Buffer.from(JSON.stringify(indexJson, null, 4)), ACL: 'public-read' }
              });
              var promise = upload.promise();

              promise.then(
                function (data) {
                  console.log("Successfully uploaded index file with status.");
                  log_file.write("Successfully uploaded index file with status.");

                  log_file.end();

                  uploadLogFile(id).then(() => {
                    removeIntermediateFiles(files, id);
                  });
                },
                function (err) {
                  console.log("There was an error uploading index file with status: ", err.message);
                  log_file.write("There was an error uploading index file with status: ", err.message);

                  log_file.end();

                  uploadLogFile(id).then(() => {
                    removeIntermediateFiles(files, id);
                  });
                }
              );
            })
          }
        })
      });
    })
  })
    .catch(error => {
      console.error("There was an error processing files")
      log_file.write("There was an error processing files");

      https.get("https://appf-anu.s3.ap-southeast-2.amazonaws.com/Cesium/index.json").on('response', function (response) {
        var body = '';
        response.on('data', function (chunk) {
          body += chunk;
        });

        response.on('end', function () {
          var indexJson = JSON.parse(body);
          indexJson.assets.map(asset => {
            if (asset.id === parseInt(id)) {
              asset.status = "failed";
              return;
            }
          })

          var upload = new AWS.S3.ManagedUpload({
            params: { Bucket: bucket, Key: `Cesium/index.json`, Body: Buffer.from(JSON.stringify(indexJson, null, 4)), ACL: 'public-read' }
          });
          var promise = upload.promise();

          promise.then(
            function (data) {
              console.log("Successfully uploaded index file with status.");
              log_file.write("Successfully uploaded index file with status.");

              log_file.end();

              uploadLogFile(id).then(() => {
                removeIntermediateFiles(files, id);
              });
            },
            function (err) {
              console.log("There was an error uploading index file with status: ", err.message);
              log_file.write("There was an error uploading index file with status: ", err.message);

              log_file.end();

              uploadLogFile(id).then(() => {
                removeIntermediateFiles(files, id);
              });
            }
          );
        });
      })
    })
}

const maxFileSize = 2000; //MB

app.post('/upload', function (req, res, next) {
  const form = formidable({ multiples: true, maxFileSize: maxFileSize * 1024 * 1024 });
  form.parse(req, (err, fields, files) => {
    if (err) {
      if (err.httpCode === 413) {
        res.status(413).send(`Maximum file size has been reached : ${maxFileSize} MB`);
      }

      return;
    }

    https.get("https://appf-anu.s3.ap-southeast-2.amazonaws.com/Cesium/index.json").on('response', function (response) {
      // http.get("http://localhost:8080/cesium/Apps/ASDC/index.json").on('response', function (response) {
      var body = '';
      response.on('data', function (chunk) {
        body += chunk;
      });

      response.on('end', function () {
        var indexJson = JSON.parse(body);
        var id = indexJson.assets[indexJson.assets.length - 1].id + 1;
        indexJson.assets.push({
          id: id,
          name: fields.name,
          status: "processing",
          categoryID: 6 //Uploads
        })

        if (!fs.existsSync(path.join(os.tmpdir(), id.toString()))) {
          fs.mkdirSync(path.join(os.tmpdir(), id.toString()));
        }
        var log_file = fs.createWriteStream(path.join(os.tmpdir(), id.toString(), 'log.txt'), { flags: 'a' });

        var upload = new AWS.S3.ManagedUpload({
          params: { Bucket: bucket, Key: `Cesium/index.json`, Body: Buffer.from(JSON.stringify(indexJson, null, 4)), ACL: 'public-read' }
        });
        var promise = upload.promise();

        promise.then(
          function (data) {
            console.log("Successfully updated index file.");
            log_file.write("Successfully updated index file.");

            processFiles(files, id.toString(), fields, log_file);

            res.send('upload received');
          },
          function (err) {
            console.log("There was an error updating index file: ", err.message);
            next(err);
          }
        );
      });
    })
  });
})


function processFileForDownload(sourcePath, inputFileName, outputFileName, headers={}) {
  return new Promise(function (resolve, reject) {
    if (sourcePath.startsWith("s3://")) {
      exec(`aws s3 cp ${sourcePath} ${path.join(os.tmpdir(), 'exports', inputFileName)}`, (error, stdout, stderr) => {
        if (error) {
          console.error(`exec error: ${error}`);
          reject();
          return;
        }
        console.log(`stdout: ${stdout}`);
        console.error(`stderr: ${stderr}`);

        exec(`conda run -n entwine pdal translate ${path.join(os.tmpdir(), 'exports', inputFileName)} ${path.join(os.tmpdir(), 'exports', outputFileName)}`, (error, stdout, stderr) => {
          if (error) {
            console.error(`exec error: ${error}`);
            reject();
            return;
          }
          console.log(`stdout: ${stdout}`);
          console.error(`stderr: ${stderr}`);

          resolve();
        })
      })
    } else {
      const file = fs.createWriteStream(path.join(os.tmpdir(), 'exports', inputFileName));
      https.get(sourcePath, {headers:headers} ,function (response) {
        response.pipe(file);
        response.on('end', function () {
          exec(`conda run -n entwine pdal translate ${path.join(os.tmpdir(), 'exports', inputFileName)} ${path.join(os.tmpdir(), 'exports', outputFileName)}`, (error, stdout, stderr) => {
            if (error) {
              console.error(`exec error: ${error}`);
              reject();
              return;
            }
            console.log(`stdout: ${stdout}`);
            console.error(`stderr: ${stderr}`);
            resolve();
          })
        })
      });
    }
  })
}

function zipFiles(sources, outputFile, remoteFiles, directories) {
  const archive = archiver('zip');
  archive.on('error', error => { throw new Error(`${error.name} ${error.code} ${error.message} ${error.path} ${error.stack}`); });
  const file = fs.createWriteStream(outputFile);

  var fileNames=[];
  if (!remoteFiles){
    var sourceFileNames = sources.map(s=>
      s.slice(s.lastIndexOf('/') + 1, s.length)
    )

    sourceFileNames.map((fn,i)=>{
      if (sourceFileNames.slice(0,i).includes(fn)){
        var count = sourceFileNames.slice(0,i).filter(x => x==fn).length;
        fileNames.push(
          `${fn.slice(0,fn.lastIndexOf('.'))}_${count}.${fn.slice(fn.lastIndexOf('.') + 1, fn.length)}`
        );
      } else {
        fileNames.push(fn)
      }
    })

    directories.map(dir=>{
      archive.directory(dir, dir.slice(dir.lastIndexOf('/') + 1, dir.length));
    })
  }

  return new Promise((resolve, reject) => {
    archive.pipe(file);
    sources.map((source,i) => {
      if (remoteFiles){
        var key = source.url.slice(`https://${bucket}.s3.ap-southeast-2.amazonaws.com/`.length, source.url.length)
        var fileName = key.slice(key.lastIndexOf('/') + 1, key.length)
        archive.append(s3.getObject({ Bucket: bucket, Key: key }).createReadStream(), { name: source.dir ? source.dir + '/' + fileName : fileName })
      } else {
        var fileName = fileNames[i];
        archive.append(fs.createReadStream(source),{name:fileName})
      }
    })
    file.on('finish', () => {
      resolve();
    });

    archive.finalize();

  })
    .catch(error => { throw new Error(`${error.code} ${error.message} ${error.data}`); });
}

app.get('/download', function (req, res, next) {
  var assetID = req.query.assetID;
  var dataID = parseInt(req.query.dataID);
  var format = req.query.format;
  var url = req.query.url;
  if (url){
    if (url.endsWith('.' + format)){
      if (url.startsWith("s3://")) {
        var signedUrl = s3.getSignedUrl('getObject', {
          Bucket: bucket,
          Key: url.slice(`s3://${bucket}/`.length, url.length),
          Expires: 3600
        })
        res.setHeader("Set-Cookie", url + `_${format}` + "=download_started;Path=/;");
        res.redirect(signedUrl);
      } else {
        res.redirect(url);
      }
    } else {
      var inputFileName = url.slice(url.lastIndexOf('/') + 1, url.length);
      var outputFileName = inputFileName.slice(0, inputFileName.lastIndexOf('.')) + '.' + format;
      
      if (!fs.existsSync(path.join(os.tmpdir(), 'exports'))) {
        fs.mkdirSync(path.join(os.tmpdir(), 'exports'));
      }

      var headers = !!trustedServers.find(s=>url.startsWith(s)) && req.headers.cookie ? {'cookie' : req.headers.cookie}:null
      processFileForDownload(url, inputFileName, outputFileName, headers).then(() => {
        res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');

        if (req.headers.origin){
          res.setHeader("Access-Control-Allow-Origin", req.headers.origin);
        }
        
        res.setHeader("Access-Control-Allow-Credentials", true);
        res.setHeader("Set-Cookie", url + `_${format}` + "=download_started;Path=/;");
        res.download(path.join(os.tmpdir(), 'exports', outputFileName), outputFileName);

        fs.rm(path.join(os.tmpdir(), 'exports', inputFileName), () => { console.log("input file removed") });
        fs.rm(path.join(os.tmpdir(), 'exports', outputFileName), () => { console.log("download file removed") });
      })
    }
  } else {
    https.get("https://appf-anu.s3.ap-southeast-2.amazonaws.com/Cesium/index.json").on('response', function (response) {
    // http.get("http://localhost:8080/cesium/Apps/ASDC/index.json").on('response', function (response) {
      var body = '';
      response.on('data', function (chunk) {
        body += chunk;
      });

      response.on('end', function () {
        var indexJson = JSON.parse(body);
        for (var i = 0; i < indexJson.assets.length; i++) {
          var asset = indexJson.assets[i];
          if (asset.id === parseInt(assetID)) {
            break
          }
        }

        for (var i = 0; i < indexJson.datasets.length; i++) {
          var data = indexJson.datasets[i];
          if (data.id === parseInt(dataID)) {
            if (data.source && data.source.url && data.source.url.endsWith('.' + format)) {
              if (data.source.url.startsWith("s3://")) {
                var url = s3.getSignedUrl('getObject', {
                  Bucket: bucket,
                  Key: data.source.url.slice(`s3://${bucket}/`.length, data.source.url.length),
                  Expires: 3600
                })

                res.setHeader("Set-Cookie", data.source.url + `_${format}` + "=download_started;Path=/;");
                res.redirect(url);
              } else {
                res.redirect(data.source.url);
              }
            } else {
              if (format != "zip") {
                if (data.source && data.source.url) {
                  var inputFileName = data.source.url.slice(data.source.url.lastIndexOf('/') + 1, data.source.url.length);
                  var outputFileName = inputFileName.slice(0, inputFileName.lastIndexOf('.')) + '.' + format;
                  
                  if (!fs.existsSync(path.join(os.tmpdir(), 'exports'))) {
                    fs.mkdirSync(path.join(os.tmpdir(), 'exports'));
                  }

                  processFileForDownload(data.source.url, inputFileName, outputFileName).then(() => {
                    res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
                    res.setHeader("Set-Cookie", data.source.url + `_${format}` + "=download_started;Path=/;");
                    res.download(path.join(os.tmpdir(), 'exports', outputFileName), outputFileName);

                    fs.rm(path.join(os.tmpdir(), 'exports', inputFileName), () => { console.log("input file removed") });
                    fs.rm(path.join(os.tmpdir(), 'exports', outputFileName), () => { console.log("download file removed") });
                  })
                } else {
                  res.status(404).send("No data source found");
                }
              } else {
                if (!fs.existsSync(path.join(os.tmpdir(), 'exports'))) {
                  fs.mkdirSync(path.join(os.tmpdir(), 'exports'));
                }
                var outFile = path.join(os.tmpdir(), 'exports', asset.name + '.zip');
                zipFiles(data.source, outFile, true).then(() => {
                  res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
                  res.setHeader("Set-Cookie", data.source[0].url + `_${format}` + "=download_started;Path=/;");

                  res.download(outFile, `${asset.name}.zip`);

                  fs.rm(outFile, () => { console.log("zip file removed") });
                })
              }
            }
            break;
          }
        }
      });
    })
  }
})

app.get('/crop', function(req, res, next) {
  var regions = JSON.parse(req.query.regions);

  var importToWebODM = req.query.importToWebODM == "true";
  var saveForWebODM = req.query.saveForWebODM == "true";

  var taskName = req.query.taskName ?? `ASDC-Export-${
    new Date().toLocaleDateString("en-au", {
      year: "numeric",
      month: "numeric",
      day: "numeric",
    })}`;


  var zipName = req.query.zipName ?? `ASDC-Export-${
    new Date().toLocaleDateString("en-au", {
      year: "numeric",
      month: "numeric",
      day: "numeric",
    })}.zip`
    .replace(/[/\\?%*:|"<>]/g, ' ')
    .slice(0,256)
    .trim();

  if (zipName.slice(zipName.length-4).toLowerCase() !=".zip") {
    zipName = zipName.slice(0,252);
    zipName += ".zip";
  }

  res.setHeader("Access-Control-Allow-Credentials", true);

  var promises = [];
  var procs = [];
  var info_procs = [];
  var files = [];
  var filesDirs=[];
  var directories = [];

  var importURL = req.query.importURL;

  regions.map((r,ri)=>{
    var url = r.url.replace(/ /gi, "+");
    const regex = /\/projects\/([^\/]*)\/tasks\/([^\/]*)\//;
    var match = regex.exec(url);
    var bbox = r.bbox;
    var polygon = r.polygon;
    var outside = r.outside;
    var type = r.type;
    var imageryType = r.imageryType;
    if(type=="ept"){
      var fileName = r.fileName ? r.fileName.replace(/[/\\?%*:|"<>]/g, ' ').slice(0,256) : "cropped.laz";
      if (fileName.slice(fileName.length-4).toLowerCase() !=".laz") {
        fileName = fileName.slice(0,252);
        fileName+=".laz";
      }
    } else if (type=="imagery"){
      var fileName = r.fileName ? r.fileName.replace(/[/\\?%*:|"<>]/g, ' ').slice(0,256) : "cropped.tif";
      if (fileName.slice(fileName.length-4).toLowerCase() !=".tif") {
        fileName = fileName.slice(0,252);
        fileName+=".tif";
      }
    }
    var metadata_req;

    if (match && match.length>=2){
      var project = match[1];
      var task = match[2];
      var headers = !!trustedServers.find(s=>url.startsWith(s)) && req.headers.cookie ? {'cookie' : req.headers.cookie}:null;
      var uuid = uuidv4();

      var URLobj = new URL(url);
      var task_metadata = `${URLobj.origin}/api/projects/${project}/tasks/${task}/`;
      var task_metadata_path = path.join(os.tmpdir(), 'exports', project, task, uuid, `task_metadata_${task}.json`);

      if(!importURL){
        importURL = `${URLobj.origin}/api/projects/${project}/tasks/import`;
      }
      if (!importToWebODM && ri==0) {
        metadata_req = fetch(task_metadata,{headers:headers})
          .then((response)=>response.text())
          .then(text=>{
            fs.writeFileSync(task_metadata_path, text);
          })
          .catch(e=>{
            console.log(e);
          })
      }
    } else {
      var project = "others";
      var uuid = uuidv4();
    }  

    if (!fs.existsSync(path.join(os.tmpdir(), 'exports'))) {
      fs.mkdirSync(path.join(os.tmpdir(), 'exports'));
    }
    if (!fs.existsSync(path.join(os.tmpdir(), 'exports', project))) {
      fs.mkdirSync(path.join(os.tmpdir(), 'exports', project));
    }

    var currentDate = new Date().toISOString().replace(/:/g,"-");

    if (task){
      if (!fs.existsSync(path.join(os.tmpdir(), 'exports', project, task))) {
        fs.mkdirSync(path.join(os.tmpdir(), 'exports', project, task));
      }

      if (!fs.existsSync(path.join(os.tmpdir(), 'exports', project, task, uuid))) {
        fs.mkdirSync(path.join(os.tmpdir(), 'exports', project, task, uuid));
      }
      var polygonGeoJSONPath = path.join(os.tmpdir(), 'exports', project, task, uuid, `crop.bounds.geojson`);

      if (importToWebODM) {
        if (type=="ept"){
          var modelDir = path.join(os.tmpdir(), 'exports', project, task, uuid, "odm_georeferencing");
          if (!fs.existsSync(modelDir)) {
            fs.mkdirSync(modelDir);
          }
          directories.push(modelDir);
          var filePath = `${path.join(modelDir, "odm_georeferenced_model.laz")}`;
        }
        
        if (type=="imagery") {
          if (imageryType.toLowerCase()=="orthophoto"){
            var dir = "odm_orthophoto";
            var file = `${dir}.tif`;
          } else if (imageryType.toLowerCase()=="dsm"){
            var dir = "odm_dem";
            var file = "dsm.tif";
          } else if (imageryType.toLowerCase()=="dtm"){
            var dir = "odm_dem";
            var file = "dtm.tif";
          }
          if (!fs.existsSync(path.join(os.tmpdir(), 'exports', project, task, uuid, dir))) {
            fs.mkdirSync(path.join(os.tmpdir(), 'exports', project, task, uuid, dir));
          }
          var fileDir=path.join(os.tmpdir(), 'exports', project, task, uuid, dir);
          var filePath = `${path.join(os.tmpdir(), 'exports', project, task, uuid, dir, file)}`;
        }
      } else {
        var filePath = `${path.join(os.tmpdir(), 'exports', project, task, uuid, fileName)}`;
      }
      var pipelinePath = path.join(os.tmpdir(), 'exports', project, task, uuid, `pipeline_${currentDate}.json`);
      var infoPipelinePath = path.join(os.tmpdir(), 'exports', project, task, uuid, `info_pipeline_${currentDate}.json`);
      var infoFilePath = path.join(os.tmpdir(), 'exports', project, task, uuid, `info_${fileName}.json`);
      var filesDir = path.join(os.tmpdir(), 'exports', project, task, uuid);

      var polygonPath = `${path.join(os.tmpdir(), 'exports', project, task, uuid, `polygon.csv`)}`;

      if (type=="imagery") {
        var dlFilePath = `${path.join(os.tmpdir(), 'exports', project, task, uuid, 'input.tif')}`;
        var polygonShpPath = `${path.join(os.tmpdir(), 'exports', project, task, uuid, `polygon.shp`)}`;
      }

      if (importToWebODM) {
        var eptPath = `${path.join(os.tmpdir(), 'exports', project, task, uuid, "entwine_pointcloud")}`;
      }
    } else {
      if (!fs.existsSync(path.join(os.tmpdir(), 'exports', project, uuid))) {
        fs.mkdirSync(path.join(os.tmpdir(), 'exports', project, uuid));
      }

      var filePath = `${path.join(os.tmpdir(), 'exports', project, uuid, fileName)}`;
      var pipelinePath = path.join(os.tmpdir(), 'exports', project, uuid, `pipeline_${currentDate}.json`);
      var infoPipelinePath = path.join(os.tmpdir(), 'exports', project, uuid, `info_pipeline_${currentDate}.json`);
      var infoFilePath = path.join(os.tmpdir(), 'exports', project, uuid, `info_${fileName}.json`);
      var filesDir = path.join(os.tmpdir(), 'exports', project, uuid);

      var polygonPath = path.join(os.tmpdir(), 'exports', project, uuid, `polygon.csv`);

      if (type=="imagery") {
        var dlFilePath = path.join(os.tmpdir(), 'exports', project, uuid, 'input.tif');
        var polygonShpPath = path.join(os.tmpdir(), 'exports', project, uuid, `polygon.shp`);
      }

      var polygonGeoJSONPath = path.join(os.tmpdir(), 'exports', project, uuid, `crop.bounds.geojson`);
    }
    filesDirs.push(filesDir);

    fs.writeFileSync(polygonPath, 
      `WKT,\n"${polygon}",`);

    if (!files.find(f=>f.endsWith("crop.bounds.geojson"))) {
      execSync(`conda run -n entwine ogr2ogr -f GeoJSON ${polygonGeoJSONPath} -dialect sqlite -sql "SELECT GeomFromText(WKT) FROM polygon" ${polygonPath} -a_srs EPSG:4326`);
      files.push(polygonGeoJSONPath);
    }
    
    if (type==="ept"){
      if (!outside){
        var pipeline= [
          {
            "type": "readers.ept",
            "filename": url,
            "bounds":`([${bbox[0]},${bbox[1]}],[${bbox[2]},${bbox[3]}],[${bbox[4]},${bbox[5]}])`
          },
          {
            "type": "filters.crop",
            "polygon": `${polygon}/EPSG:4326`,
            "a_srs": "EPSG:4326",
          },
          {
            "type": "writers.las",
            "filename": filePath
          }
        ]
      } else {
        var pipeline = [
          {
            "type": "readers.ept",
            "filename": url
          },
          {
            "type": "filters.crop",
            "polygon": `${polygon}/EPSG:4326`,
            "where": `Z>=${bbox[4]} && Z<=${bbox[5]}`,
            "a_srs": "EPSG:4326",
            "outside": true
          },
          {
            "type": "writers.las",
            "filename": filePath
          }
        ]
      }

      var info_pipeline = [
        {
          "type": "readers.las",
          "filename" : filePath
        },
        {
          "type":"filters.info"
        }
      ]

      if (headers) {
        pipeline[0].header=headers;
      }

      fs.writeFileSync(pipelinePath, JSON.stringify(pipeline));
      fs.writeFileSync(infoPipelinePath, JSON.stringify(info_pipeline));    
      
      var promise = new Promise((resolve, reject) => {
        var proc = exec(`conda run -n entwine pdal pipeline "${pipelinePath}"`,(error, stdout, stderr)=>{
          if (error) {
            console.error(`exec error: ${error}`);
            reject();
            return;
          }
          console.log(`stdout: ${stdout}`);
          console.error(`stderr: ${stderr}`);

          if (!importToWebODM) {
            var info_proc = exec(`conda run -n entwine pdal pipeline "${infoPipelinePath}" --metadata "${infoFilePath}"`,(error, stdout, stderr)=>{
              if (error) {
                console.error(`exec error: ${error}`);
                reject();
                return;
              }
              console.log(`stdout: ${stdout}`);
              console.error(`stderr: ${stderr}`);

              var data = fs.readFileSync(infoFilePath, {encoding:'utf8', flag:'r'});
              data = JSON.parse(data);
              var num_points = data.stages["filters.info"]["num_points"];
              if (num_points>0){
                files.push(filePath);
                files.push(infoFilePath);
              }
              if (metadata_req){
                metadata_req.then(()=>{
                  files.push(task_metadata_path)
                  resolve();
                })
              } else {
                resolve();
              }
            })
            info_procs.push(info_proc);
          } else {
            var eptProc = exec(`conda run -n entwine entwine build -i "${filePath}" -o "${eptPath}"`,(error, stdout, stderr)=>{
              if (error) {
                console.error(`exec error: ${error}`);
                reject();
                return;
              }
              console.log(`stdout: ${stdout}`);
              console.error(`stderr: ${stderr}`);

              directories.push(eptPath);

              resolve();
            })

            procs.push(eptProc);
          }
        })
        procs.push(proc);
      })
      promises.push(promise);
    } else if (type=="imagery") {
  
      execSync(`conda run -n entwine ogr2ogr -f "ESRI Shapefile" ${polygonShpPath} -dialect sqlite -sql "SELECT GeomFromText(WKT) FROM polygon" ${polygonPath} -a_srs EPSG:4326`);

      if (!outside) {
        var promise = new Promise((resolve, reject) => {
          var proc = exec(`conda run -n entwine gdalwarp -cutline "${polygonPath}" -crop_to_cutline "/vsicurl?${req.headers.cookie ? `cookie=${req.headers.cookie}&`:""}url=${url}" "${filePath}"`,(error, stdout, stderr)=>{
            if (error) {
              if (error.message.includes("Range downloading not supported by this server")) {
                var dlProc = exec(`curl ${url} --output ${dlFilePath} --header "cookie:${req.headers.cookie}"`,(error, stdout, stderr)=>{
                  if (error) {
                    console.error(`exec error: ${error}`);
                    reject();
                  }
                  console.log(`stdout: ${stdout}`);
                  console.error(`stderr: ${stderr}`);
                  
                  var localProc = exec(`conda run -n entwine gdalwarp -cutline "${polygonPath}" -crop_to_cutline "${dlFilePath}" "${filePath}"`,(error, stdout, stderr)=>{
                    if (error) {
                      console.error(`exec error: ${error}`);
                    }
                    console.log(`stdout: ${stdout}`);
                    console.error(`stderr: ${stderr}`);

                    if (!importToWebODM) {
                      files.push(filePath);
    
                      if (metadata_req){
                        metadata_req.then(()=>{
                          files.push(task_metadata_path)
                          resolve();
                        })
                      } else {
                        resolve();
                      }
                    } else {
                      directories.push(fileDir);
                      
                      resolve();
                    }
                  })
                  procs.push(localProc);
  
                })
                procs.push(dlProc);
              } else {
                reject();
              }
            } else {
              if (metadata_req){
                metadata_req.then(()=>{
                  files.push(task_metadata_path)
                  resolve();
                })
              } else {
                resolve();
              }
            }
            console.log(`stdout: ${stdout}`);
            console.error(`stderr: ${stderr}`);
          })
          procs.push(proc);
        })
        promises.push(promise);
      }
    }
  })

  var project = "others";
  var uuid = uuidv4();

  if (!fs.existsSync(path.join(os.tmpdir(), 'exports', project))) {
    fs.mkdirSync(path.join(os.tmpdir(), 'exports', project));
  }

  if (!fs.existsSync(path.join(os.tmpdir(), 'exports', project, uuid))) {
    fs.mkdirSync(path.join(os.tmpdir(), 'exports', project, uuid));
  }

  var zipDir = path.join(os.tmpdir(), 'exports', project, uuid)
  var zipPath = path.join(zipDir, zipName);
  filesDirs.push(zipDir);

  Promise.all(promises).then(()=>{
      zipFiles(files, zipPath, false, directories).then(() => {
        if (!importToWebODM) {
          res.download(zipPath, function (err) {
            filesDirs.map(filesDir => {
              if (fs.existsSync(filesDir)) {
                fs.rmSync(filesDir, { recursive: true })
              }
            })
          });
        } else {
          if (saveForWebODM) {
            res.download(zipPath, function (err) {
              filesDirs.map(filesDir => {
                if (fs.existsSync(filesDir)) {
                  fs.rmSync(filesDir, { recursive: true })
                }
              })
            });
          } else {
            const form = new FormData();
            const buffer = fs.createReadStream(zipPath);
            const fileName = zipPath;
            form.append('name',taskName)
            form.append('file', buffer, {
              contentType: 'application/zip',
              name: 'file',
              filename: fileName,
            });

            var fetchHeaders = {
              "accept": "application/json",
              "cache-control": "no-cache",
              'Content-Type': `multipart/form-data;boundary=${form._boundary}`,
              "x-requested-with": "XMLHttpRequest",
              "Referer": importURL,
            }

            if (!!trustedServers.find(s=>importURL.startsWith(s)) && req.headers.cookie) {
              var parsedCookies = req.headers.cookie
                .split(";")
                .map((v) => v.split("="))
                .reduce((acc, v) => {
                  if (v[0] && v[1]) {
                    acc[decodeURIComponent(v[0].trim())] = decodeURIComponent(
                      v[1].trim()
                    );
                  }
                  return acc;
                }, {});

                fetchHeaders["x-csrftoken"] = parsedCookies.csrftoken;
                fetchHeaders["cookie"] = req.headers.cookie;
            }

            fetch(importURL, {
              "headers": fetchHeaders,
              body:form,
              "method": "POST"
            })
            .then((resp)=>{
              if (resp.status==201){
                res.sendStatus(201);
                filesDirs.map(filesDir => {
                  if (fs.existsSync(filesDir)) {
                    fs.rmSync(filesDir, { recursive: true })
                  }
                })
              } else {
                res.download(zipPath, function (err) {
                  filesDirs.map(filesDir => {
                    if (fs.existsSync(filesDir)) {
                      fs.rmSync(filesDir, { recursive: true })
                    }
                  })
                });
              }
            })
            .catch(e=>{
              res.download(zipPath, function (err) {
                filesDirs.map(filesDir => {
                  if (fs.existsSync(filesDir)) {
                    fs.rmSync(filesDir, { recursive: true })
                  }
                })
              });
            })
          }
        }      
      })
  }).catch((e)=>{
    console.log(e)
    res.status(500).send("An error occured during the export process");
  })

  req.on('close', function (err){
    procs.map(proc=>{
      if (proc && proc.pid) kill(proc.pid);
    })
    info_procs.map(info_proc=>{
      if (info_proc &&  info_proc.pid) kill(info_proc.pid);
    })
    filesDirs.map(filesDir=>{
      if (fs.existsSync(filesDir)) {
        fs.rmSync(filesDir, { recursive: true })
      }
    })
  });
})

app.get('/eptNumPoints', function(req, res, next) {
  var ept = req.query.ept;
  var bbox = req.query.bbox.split(',');
  var polygon = req.query.polygon;
  var uuid = uuidv4();
  var headers = !!trustedServers.find(s=>ept.startsWith(s)) && req.headers.cookie ? {'cookie' : req.headers.cookie}:null;

  if (!fs.existsSync(path.join(os.tmpdir(), 'pdal_pipelines'))) {
    fs.mkdirSync(path.join(os.tmpdir(), 'pdal_pipelines'));
  }
  if (!fs.existsSync(path.join(os.tmpdir(), 'pdal_pipelines', uuid))) {
    fs.mkdirSync(path.join(os.tmpdir(), 'pdal_pipelines', uuid));
  }

  var pipeline = [
    {
      "type": "readers.ept",
      "filename": ept,
      "bounds": `([${bbox[0]},${bbox[1]}],[${bbox[2]},${bbox[3]}],[${bbox[4]},${bbox[5]}])`,
      // "polygon": `${polygon}/EPSG:4326`  //wrong results
    },
    {
      "type": "filters.crop",
      "polygon": `${polygon}/EPSG:4326`,
      "a_srs": "EPSG:4326",
    },
    {
      "type":"filters.info"
    }
  ]

  if (headers){
    pipeline[0].header = headers;
  }
  res.setHeader("Access-Control-Allow-Credentials", true);

  fs.writeFileSync(path.join(os.tmpdir(), 'pdal_pipelines', uuid, `pipeline_${uuid}.json`), JSON.stringify(pipeline));

  var proc = exec(`conda run -n entwine pdal pipeline ${path.join(os.tmpdir(), 'pdal_pipelines', uuid, `pipeline_${uuid}.json`)} --metadata ${path.join(os.tmpdir(), 'pdal_pipelines', uuid, `info_${uuid}.json`)}`,(error, stdout, stderr) => {
    if (error) {
      console.error(`exec error: ${error}`);
      res.status(500).send();
      return;
    }
    console.log(`stdout: ${stdout}`);
    console.error(`stderr: ${stderr}`);

    var data = fs.readFileSync(`${path.join(os.tmpdir(), 'pdal_pipelines', uuid, `info_${uuid}.json`)}`, {encoding:'utf8', flag:'r'});
    data = JSON.parse(data);

    res.send(data.stages["filters.info"]["num_points"].toString());

    if (fs.existsSync(path.join(os.tmpdir(), 'pdal_pipelines', uuid))) {
      fs.rmSync(path.join(os.tmpdir(), 'pdal_pipelines', uuid), { recursive: true })
    }
  })

  req.on('close', function (err){
    kill(proc.pid);

    if (fs.existsSync(path.join(os.tmpdir(), 'pdal_pipelines', uuid))) {
      fs.rmSync(path.join(os.tmpdir(), 'pdal_pipelines', uuid), { recursive: true })
    }
 });
})

app.get('/eptFileSize', function(req, res, next) {
  var ept = req.query.ept;
  var eptHierarchy = ept.slice(0,ept.length-9) + `/ept-hierarchy/0-0-0-0.json`;
  var headers = !!trustedServers.find(s=>ept.startsWith(s)) && req.headers.cookie ? {'cookie' : req.headers.cookie}:null;
  
  res.setHeader("Access-Control-Allow-Credentials", true);

  var controller = new AbortController();

  fetch(eptHierarchy,{
    signal:controller.signal,
    headers:headers
  })
  .then((response)=>response.json())
  .then((response)=>{
    var reqs = [];
    var total = 0;
    Object.keys(response).map(k=>{
      var eptData = ept.slice(0,ept.length-9) + `/ept-data/${k}.laz`;
      reqs.push(
          fetch(eptData, { 
            method: 'HEAD',
            signal:controller.signal,
            headers:headers
          })
          .then((resp)=>{
            const contentLength = resp.headers.get('Content-Length');
            total += Number(contentLength);
          })
          .catch((error) => {
            if (error.name !== "AbortError") {
              console.log(error);
              controller.abort();
              return error;
            }
          })
      )
    })

    Promise.all(reqs).then((resps)=>{      
      if(!resps.find(r=>r instanceof Error)){
        res.send(total.toString());
      } else {
        res.status(500).send();
      }
    }).catch((error) => {
      if (error.name !== "AbortError") {
        console.log(error);
      }
    })
  })
  .catch((error) => {
    if (error.name !== "AbortError") {
      console.log(error);
    }
  })

  req.on('close', function (err){
    controller.abort();
  }); 
})

app.get('/wkt2geojson', function(req, res, next) {
  wkt=req.query.wkt;

  var uuid = uuidv4();
  if (!fs.existsSync(path.join(os.tmpdir(), 'exports'))) {
    fs.mkdirSync(path.join(os.tmpdir(), 'exports'));
  }
  if (!fs.existsSync(path.join(os.tmpdir(), 'exports', uuid))) {
    fs.mkdirSync(path.join(os.tmpdir(), 'exports', uuid));
  }
  var polygonPath = `${path.join(os.tmpdir(), 'exports', uuid, `polygon.csv`)}`;
  var polygonGeoJSONPath = `${path.join(os.tmpdir(), 'exports', uuid, `polygon.geojson`)}`;

  fs.writeFileSync(polygonPath, 
    `WKT,\n"${wkt}",`);

  execSync(`conda run -n entwine ogr2ogr -f GeoJSON ${polygonGeoJSONPath} -dialect sqlite -sql "SELECT GeomFromText(WKT) FROM polygon" ${polygonPath} -a_srs EPSG:4326`);
  
  res.download(polygonGeoJSONPath, function (err) {
    if (fs.existsSync(`${path.join(os.tmpdir(), 'exports', uuid)}`)) {
      fs.rmSync(`${path.join(os.tmpdir(), 'exports', uuid)}`, { recursive: true })
    }
  });
})

app.get('/test', function (req, res, next) {
  res.send('test');
})

const server = app.listen(8081, "0.0.0.0");