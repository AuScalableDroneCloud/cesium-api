const express = require("express");
const app = express();
const formidable = require('formidable');
var AWS = require('aws-sdk');
var fs = require("fs");
var https = require("https");
const os = require('os');

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

const path = require('path');

function uploadLogFile(id) {
  var uploadLog = new AWS.S3.ManagedUpload({
    params: { Bucket: bucket, Key: `Cesium/Uploads/${id}/log.txt`, Body: fs.createReadStream(path.join(os.tmpdir(), id.toString(), 'log.txt')), ACL: 'public-read' }
  });
  var uploadLogPromise = uploadLog.promise();

  uploadLogPromise.then(
    function (data) {
      console.log("Uploaded log file");      
    },
    function (err) {
      console.log("There was an error uploading log file: ", err.message);
    }
  );
}

function processFile(filepath, id, index, originalFilename,log_file) {
  return new Promise(function (resolve, reject) {
    fs.renameSync(filepath, filepath + '.laz');

    exec(`aws s3 cp ${filepath + '.laz'} s3://appf-anu/Cesium/Uploads/${id}/${index}/${originalFilename}`, (error, stdout, stderr) => {
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

      exec(`conda run -n entwine entwine build -i ${filepath + '.laz'} -o ${path.join(path.dirname(filepath + '.laz'), id, index.toString(), 'ept')}`, (error, stdout, stderr) => {
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

        exec(`conda run -n entwine ept tile ${path.join(path.dirname(filepath + '.laz'), id, index.toString(), 'ept')} --truncate`, (error, stdout, stderr) => {
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

          exec(`aws s3 cp ${path.join(path.dirname(filepath + '.laz'), id, index.toString(), 'ept')} s3://appf-anu/Cesium/Uploads/${id}/${index}/ept --recursive --acl public-read`, (error, stdout, stderr) => {
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
            fs.rmSync(filepath + '.laz');
            fs.rmSync(path.join(path.dirname(filepath + '.laz'), id, index.toString()), { recursive: true });
            resolve();
          });
        });
      });
    });
  });
}


async function processFiles(files, id, fields,log_file) {
  var promises = [];

  if (Array.isArray(files['files[]'])) {
    files['files[]'].map((file, index) => {
      var filepath = file.filepath;
      index = index.toString();
      var originalFilename = file.originalFilename;

      promises.push(processFile(filepath, id, index, originalFilename,log_file));
    })
  } else {
    var filepath = files['files[]'].filepath;
    var index = 0;
    var originalFilename = files['files[]'].originalFilename;

    promises.push(processFile(filepath, id, index, originalFilename,log_file));
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

            if (Array.isArray(files['files[]'])) {
              files['files[]'].map((file, index) => {
                asset.data.push({
                  date: fields.dates[index],
                  type: "PointCloud",
                  url: `https://appf-anu.s3.ap-southeast-2.amazonaws.com/Cesium/Uploads/${id}/${index}/ept/ept-tileset/tileset.json`
                })
              })
            } else {
              asset.data.push({
                date: fields.dates[index],
                type: "PointCloud",
                url: `https://appf-anu.s3.ap-southeast-2.amazonaws.com/Cesium/Uploads/${id}/${index}/ept/ept-tileset/tileset.json`
              })
            }

            asset.status = "active";
            return;
          }
        })

        var upload = new AWS.S3.ManagedUpload({
          params: { Bucket: bucket, Key: `Cesium/index.json`, Body: Buffer.from(JSON.stringify(indexJson, null, 4)), ACL: 'public-read' }
        });
        var promise = upload.promise();

        promise.then(
          function (data) {
            console.log("Successfully updated index file with urls.");
            log_file.write("Successfully updated index file with urls.");

            log_file.end();

            uploadLogFile(id);
          },
          function (err) {
            console.log("There was an error updating index file with urls: ", err.message);
            log_file.write("There was an error updating index file with urls: ", err.message);

            log_file.end();
            uploadLogFile(id);
          }
        );
      });
    })
  }).catch(error => {
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
            console.log("Successfully updated index file with status.");
            log_file.write("Successfully updated index file with status.");

            log_file.end();

            uploadLogFile(id);

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
          },
          function (err) {
            console.log("There was an error updating index file with status: ", err.message);
            log_file.write("There was an error updating index file with status: ", err.message);

            log_file.end();
            uploadLogFile(id);

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
        );
      });
    })    
  });
}

const maxFileSize = 2000; //MB

app.post('/upload', function (req, res, next) {
  const form = formidable({ multiples: true, maxFileSize: maxFileSize * 1024 * 1024 });
  form.parse(req, (err, fields, files) => {
    if (err) {
      if(err.httpCode===413){
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
          status: "processing"
        })

        if (!fs.existsSync(path.join(os.tmpdir(), id.toString()))) {
          fs.mkdirSync(path.join(os.tmpdir(), id.toString()));
        }
        var log_file = fs.createWriteStream(path.join(os.tmpdir(), id.toString(), 'log.txt'), {flags : 'a'});

        var upload = new AWS.S3.ManagedUpload({
          params: { Bucket: bucket, Key: `Cesium/index.json`, Body: Buffer.from(JSON.stringify(indexJson, null, 4)), ACL: 'public-read' }
        });
        var promise = upload.promise();

        promise.then(
          function (data) {
            console.log("Successfully updated index file.");
            log_file.write("Successfully updated index file.");

            processFiles(files, id.toString(), fields,log_file);

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

app.get('/test', function (req, res, next) {
  res.send('test');
})

const server = app.listen(8081, "0.0.0.0");