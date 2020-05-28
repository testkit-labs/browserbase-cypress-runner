#!/usr/bin/env node
const path = require('path');
const fs = require('fs');
const tmp = require('tmp');
const archiver = require('archiver');
const yargs = require('yargs').argv;
const ora = require('ora');
const chalk = require('chalk');
const request = require('request');
const {default: PQueue} = require('p-queue');
const got = require('got');
const cliProgress = require('cli-progress');
const { merge } = require('mochawesome-merge')
const { table } = require('table')
const uploadAPI = "https://app.browserbase.io/api/v1/cypress/upload"

var testResults = []
var progressBar
var orgId
var paralellRunners = 1
var npmDeps = []

function verbose(message) {
    if (yargs.verbose) {
        console.log(chalk.grey(message))
    }
}

function zipCypressFiles(cypressSource) {
    var ret
    const tmpArchive = tmp.fileSync();
    var output = fs.createWriteStream(tmpArchive.name);
    var archive = archiver('zip');
    archive.pipe(output);
    archive.directory(path.join(cypressSource, "cypress"), "cypress");
    archive.file(path.join(cypressSource, "cypress.json"), {"name": "cypress.json"});
    archive.finalize();
    output.on('close', function() {
        ret = true
    });
    while(ret === undefined) {
        require('deasync').sleep(100);
    }
    verbose("Created archive " + tmpArchive.name)
    return tmpArchive.name
}

function uploadCypressFiles(file) {
    var ret
    var options = {
        url: uploadAPI,
        formData: {
            "orgId": orgId,
            "zipfile": fs.readFileSync(file)
        }
    };
    request.post(options, function (err, resp, body) {
        if (err) {
            verbose(err);
            ret = {"error": "Unable to upload files to Browserbase servers"}
        }
        else {
            ret = body
            verbose(body)
        }
    });
    while(ret === undefined) {
        require('deasync').sleep(100);
    }
    return ret
}

function getSpecFiles(dirPath, arrayOfFiles) {
    if (!fs.existsSync(dirPath)) {
        console.error("Specified cypress directory " + dirPath + " does not exist! Please check the --path argument and try again")
        process.exit(1)
    }
    files = fs.readdirSync(dirPath)
    arrayOfFiles = arrayOfFiles || []
    files.forEach(function(file) {
      if (fs.statSync(dirPath + "/" + file).isDirectory()) {
        arrayOfFiles = getSpecFiles(dirPath + "/" + file, arrayOfFiles)
      } else {
          if (path.extname(file) == ".js") {
            arrayOfFiles.push(path.join(dirPath, "/", file))
          }
      }
    })
    return arrayOfFiles
}

function sleep(ms) {
    return new Promise((resolve) => {
      setTimeout(resolve, ms);
    });
} 


async function runTest(specFile, url) {
    const sessionRepsonse = await got.post('https://' + orgId + '.gateway.browserbase.io/wd/hub/session', {
		json: {
            "desiredCapabilities": {
                "browserName": "cypress",
                "cypressURL": url,
                "specFile": specFile,
                "orgId": orgId,
                "deps": npmDeps,
                "bb:options": {
                    name: "Cypress Test " + specFile
                }
            }
		},
		responseType: 'json'
    });
    jsonSessionRepsonse = sessionRepsonse.body
    if (!jsonSessionRepsonse.sessionId) {
        console.error("Failed to launch session for spec " + specFile);
        console.error(error);
        return;
    }
    var sessionId = jsonSessionRepsonse.sessionId
    verbose("Created session ID " + sessionId + " to run spec " + specFile)
    var finished
    var logs = []
    while (finished == undefined) {
        try {
            var response = await got('https://' + orgId + '.gateway.browserbase.io/wd/hub/session/' + sessionId + '/logs', {responseType: 'json'});
            response.body.forEach(function(entry) {
                verbose("Received log entry " + JSON.stringify(entry))
                if (entry.success != undefined) {
                    verbose("Entry has no success field, pushing to logs array")
                    finished = entry.success
                } else {
                    logs.push(entry)
                }
            });
        } catch (error) {
            console.error("Error")
            console.error(error);
            return
        }
        await sleep(1000)
    }
    testResults.push({"spec": specFile,
                      "sessionId": sessionId,
                      "passed": finished,
                      "logs": logs})
    progressBar.increment()
    getReport(sessionId)
    await sleep(3000)
    try {
        got.delete('https://' + orgId + '.gateway.browserbase.io/wd/hub/session/' + sessionId)
        verbose("Removed session ID " + sessionId)
    } catch (error) {
        verbose("Failed to remove session ID " + sessionId)
        verbose(error)
    }
}

function getReport(sessionId) {
    var url = `https://${orgId}.gateway.browserbase.io/wd/hub/session/${sessionId}/getReport`
    request(url, {encoding: 'binary'}, function(error, response, body) {
        if (error) {
            console.error(error)
        }
        fs.writeFile(`reports/${sessionId}.json`, body, 'binary', function (err) {
            if (err) {
                verbose(err)
            }
            verbose(`wrote file reports/${sessionId}.json`)
        });
    });
}

function writeSummary() {
    console.log("-------------------------------------------")
    console.log("-----------------RESULTS-------------------")
    console.log("-------------------------------------------")
    var resultsTable = []
    resultsTable.push([chalk.bold("Specfile"), chalk.bold("Result"), chalk.bold("Browserbase Link")])
    testResults.forEach(function(entry) {
        if (entry.passed) {
            resultsTable.push([entry.spec, chalk.bgGreen(" Passed "), "https://app.browserbase.io/session/" + entry.sessionId])
        } else {
            resultsTable.push([entry.spec, chalk.bgRed(" Failed "), "https://app.browserbase.io/session/" + entry.sessionId])
        }
        
    });
    console.log(table(resultsTable))
}

function mergeReports() {
    const options = {
    files: [
        './reports/*.json'
    ],
    }
    
    merge(options).then(report => {
        fs.writeFile(`report.json`, JSON.stringify(report, null, 2), function (err) {
            if (err) {
                verbose(err)
            }
            verbose(`Merged mochawesome reports into one`)
            deletePerTestReports()
        });

    })
}

function deletePerTestReports() {
    fs.readdir("reports", (err, files) => {
        if (err) console.error("Unable to remove single test files");
      
        for (const file of files) {
          fs.unlink(path.join("reports", file), err => {
            if (err) throw err;
          });
        }
      });
}

function createWorkerThreads(specArray, url, directoryPath) {
    progressBar = new cliProgress.SingleBar({}, cliProgress.Presets.shades_classic);
    const queue = new PQueue({concurrency: paralellRunners});
    console.log('Starting testing workers with ' + paralellRunners + ' paralell threads')
    progressBar.start(specArray.length, 0);
    specArray.forEach(function(item) {
        queue.add(() => runTest(path.relative(path.join(directoryPath, "cypress"), item), url))
    })
    queue.on('idle', () => {
        progressBar.stop();
        writeSummary()
        try {
            mergeReports()
        } catch (e) {
            verbose("Could not merge reports")
        }
        
    });
}

function checkArgs() {
    var spinner = ora('Looking for spec files...').start();
    var directoryPath = path.join(process.cwd());
    var specDirectory = "integration"
    var configFile = fs.readFileSync('browserbase.json','utf8')
    var parsedConfigFile = JSON.parse(configFile)
    if (parsedConfigFile.path) {
        directoryPath = path.join(parsedConfigFile.path)
    }
    if (yargs.path) {
        directoryPath = path.join(yargs.path);
    }
    if (parsedConfigFile.org) {
        orgId = parsedConfigFile.org
    }
    if (yargs.org) {
        orgId = yargs.org
    }
    if (!orgId) {
        console.error("No org specified, please check your config and try again")
        process.exit(1)
    }
    if (parsedConfigFile.specs) {
        specDirectory = parsedConfigFile.specs
    }
    if (yargs.specs) {
        specDirectory = yargs.specs
    }
    if (parsedConfigFile.paralell) {
        paralellRunners = parsedConfigFile.paralell
    }
    if (yargs.paralell) {
        paralellRunners = parsedConfigFile.paralell
    }
    if (parsedConfigFile["additional-dependencies"]) {
        npmDeps = parsedConfigFile["additional-dependencies"]
    }
    var specArray = getSpecFiles(path.join(directoryPath, "cypress", specDirectory))
    if (specArray.length == 0) {
        console.error("Unable to find any spec files in the directory " + path.join(directoryPath, "cypress", specDirectory))
        process.exit(1)
    }
    spinner.succeed("Looking for spec files... Found " + specArray.length + " spec files!")
    spinner = ora('Bundling spec files...').start();
    var archiveName = zipCypressFiles(directoryPath)
    spinner.succeed()
    spinner = ora("Uploading spec files to Browserbase servers...").start();
    var uploadStatus = uploadCypressFiles(archiveName)
    var uploadStatusJSON = JSON.parse(uploadStatus);
    if (!uploadStatusJSON.url) {
        spinner.fail()
        console.error("Unable to upload files to Browserbase servers! Error is")
        console.error(uploadStatusJSON)
        process.exit(1)
    }
    spinner.succeed()
    createWorkerThreads(specArray, uploadStatusJSON.url, directoryPath)
}
console.log("")
console.log(chalk.bold("    Initializing the Browserbase Cypress Test Runner..."))
console.log("")
checkArgs()