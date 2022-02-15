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

// app.use(compression());
app.use(function (req, res, next) {
  res.header("Access-Control-Allow-Origin", "*");
  res.header(
    "Access-Control-Allow-Headers",
    "Origin, X-Requested-With, Content-Type, Accept"
  );
  next();
});

const { exec } = require('child_process');

var bucket = "appf-anu";

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

function updateAsset(asset, id, index, date, originalFilename) {
  return new Promise(function (resolve, reject) {
    var tileset = new Cesium.Cesium3DTileset({
      url: `https://appf-anu.s3.ap-southeast-2.amazonaws.com/Cesium/Uploads/${id}/${index}/ept/ept-tileset/tileset.json`
    });

    tileset.readyPromise.then((tileset) => {
      var carto = Cesium.Cartographic.fromCartesian(tileset.boundingSphere.center);

      asset.data.push({
        date: date,
        type: "PointCloud",
        url: `https://appf-anu.s3.ap-southeast-2.amazonaws.com/Cesium/Uploads/${id}/${index}/ept/ept-tileset/tileset.json`,
        position: {
          lng: carto.longitude * Cesium.Math.DEGREES_PER_RADIAN,
          lat: carto.latitude * Cesium.Math.DEGREES_PER_RADIAN,
          height: carto.height
        },
        boundingSphereRadius:tileset.boundingSphere.radius,
        source: {
          url: `s3://appf-anu/Cesium/Uploads/${id}/${index}/${originalFilename}`
        }
      });

      tileset = tileset && tileset.destroy();
      resolve(asset);
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
        ept.schema.map(_schema=>{
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
                updatePromises.push(updateAsset(asset, id, index, fields.dates[index], originalFilename));
              })
            } else {
              updatePromises.push(updateAsset(asset, id, 0, fields.dates[0], originalFilename));
            }

            Promise.all(updatePromises).then(() => {
              asset.status = "active";

              var upload = new AWS.S3.ManagedUpload({
                params: { Bucket: bucket, Key: `Cesium/index.json`, Body: Buffer.from(JSON.stringify(indexJson, null, 4)), ACL: 'public-read' }
              });
              var promise = upload.promise();

              promise.then(
                function (data) {
                  console.log("Successfully uploading index file with with positions and urls.");
                  log_file.write("Successfully uploading index file with with positions and urls.");

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
                  console.log("Successfully uploading index file with status.");
                  log_file.write("Successfully uploading index file with status.");

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
            console.log("Successfully uploading index file with status.");
            log_file.write("Successfully uploading index file with status.");

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


function processFileForDownload(sourcePath, inputFileName, outputFileName) {
  return new Promise(function (resolve, reject) {
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

        var tomorrow = new Date();
        tomorrow.setDate(tomorrow.getDate() + 1);

        exec(`aws s3 cp ${path.join(os.tmpdir(), 'exports', outputFileName)} s3://appf-anu/Cesium/Exports/${outputFileName} --expires ${tomorrow.toISOString()}`, (error, stdout, stderr) => {
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
    })
  })
}

function zipFiles(sources, outputFileName) {
  const archive = archiver('zip');
  archive.on('error', error => { throw new Error(`${error.name} ${error.code} ${error.message} ${error.path} ${error.stack}`); });

  const streamPassThrough = new stream.PassThrough();
  
  var tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);

  const s3Upload = s3.upload({
    ACL: 'private',
    Body: streamPassThrough,
    Bucket: bucket,
    ContentType: 'application/zip',
    Key: `Cesium/Exports/${outputFileName}.zip`,
    Expires:tomorrow
  }, error => {
    if (error) {
      console.error(`Got error creating stream to s3 ${error.name} ${error.message} ${error.stack}`);
      throw error;
    }
  });

  s3Upload.on('httpUploadProgress', (progress) => {
    console.log(progress);
  });

  return new Promise((resolve, reject) => {
    archive.pipe(streamPassThrough);
    sources.map((source) => {
      var key = source.url.slice(`https://${bucket}.s3.ap-southeast-2.amazonaws.com/`.length, source.url.length)
      var fileName = key.slice(key.lastIndexOf('/') + 1, key.length)
      archive.append(s3.getObject({ Bucket: bucket, Key: key }).createReadStream(), { name: source.dir? source.dir +'/' + fileName: fileName })
    })
    archive.finalize();
    s3Upload.promise().then(resolve).catch(reject);
  })
    .catch(error => { throw new Error(`${error.code} ${error.message} ${error.data}`); });
}

app.get('/download', function (req, res, next) {
  var assetID = req.query.assetID;
  var dataIndex = parseInt(req.query.dataIndex);
  var format = req.query.format;
  https.get("https://appf-anu.s3.ap-southeast-2.amazonaws.com/Cesium/index.json").on('response', function (response) {
  // http.get("http://localhost:8080/cesium/Apps/index.json").on('response', function (response) {
    var body = '';
    response.on('data', function (chunk) {
      body += chunk;
    });

    response.on('end', function () {
      var indexJson = JSON.parse(body);

      for (var i = 0; i < indexJson.assets.length; i++) {
        var asset = indexJson.assets[i];
        if (asset.id === parseInt(assetID)) {

          var data = asset.data[dataIndex];
          if (data.source && data.source.url && data.source.url.endsWith('.' + format)) {
            var url = s3.getSignedUrl('getObject', {
              Bucket: bucket,
              Key: data.source.url.slice(`s3://${bucket}/`.length, data.source.url.length),
              Expires: 3600
            })
            res.status(302).send(url);
          } else {
            if (format != "zip") {
              var inputFileName = data.source.url.slice(data.source.url.lastIndexOf('/') + 1, data.source.url.length);
              var outputFileName = inputFileName.slice(0, inputFileName.lastIndexOf('.')) + '.' + format;

              s3.headObject({ Bucket: bucket, Key: `Cesium/Exports/${outputFileName}` }, function (err) {
                if (err && err.code === 'NotFound') {
                  processFileForDownload(data.source.url, inputFileName, outputFileName).then(() => {
                    var url = s3.getSignedUrl('getObject', {
                      Bucket: bucket,
                      Key: `Cesium/Exports/${outputFileName}`,
                      Expires: 3600
                    })

                    fs.rm(path.join(os.tmpdir(), 'exports', inputFileName), () => { console.log("input file removed") });
                    fs.rm(path.join(os.tmpdir(), 'exports', outputFileName), () => { console.log("download file removed") });

                    res.status(302).send(url);
                  })
                } else {
                  var url = s3.getSignedUrl('getObject', {
                    Bucket: bucket,
                    Key: `Cesium/Exports/${outputFileName}`,
                    Expires: 3600
                  })
                  res.status(302).send(url);
                }
              });
            } else {
              s3.headObject({ Bucket: bucket, Key: `Cesium/Exports/${asset.name}.zip` }, function (err) {
                if (err && err.code === 'NotFound') {
                  zipFiles(data.source, asset.name).then(() => {
                    var url = s3.getSignedUrl('getObject', {
                      Bucket: bucket,
                      Key: `Cesium/Exports/${asset.name}.zip`,
                      Expires: 3600
                    })
                    res.status(302).send(url);
                  })
                } else {
                  var url = s3.getSignedUrl('getObject', {
                    Bucket: bucket,
                    Key: `Cesium/Exports/${asset.name}.zip`,
                    Expires: 3600
                  })
                  res.status(302).send(url);
                }
              })
            }
          }
          break;
        }
      }
    });
  })
})

app.get('/test', function (req, res, next) {
  res.send('test');
})

const server = app.listen(8081, "0.0.0.0");