'use strict';

var unzip = require('unzip'),
    fs = require('fs'),
    _ = require('lodash'),
    path = require('path'),
    uuid = require('node-uuid'),
    zlib = require('zlib'),
    exec = require('child_process').exec,
    filenameRegexPattern = /^raw\/([0-9]+)_([cs])\.txt$/,
    lineBreak = '\r\n';

function parser(filePath, options, callback) {
    fs.stat(filePath, function(err) {
        if (err) {
            return callback(err);
        }
        var dir = uuid.v1()
        fs.createReadStream(filePath)
            .pipe(unzip.Extract({ path: 'output/' + dir }))
            .on('error', callback)
            .on('close', function() {
                var dirPath = path.resolve('output/' + dir)
                parserProcess(dirPath, options);
            })
    })

    function parserProcess(dirPath, options) {
      try {
            var sessions = parse(dirPath, options);
            callback(null, sessions)
        } catch(err) {
            callback(err)
        } finally {
            exec('rm -rf ' + dirPath)
        }
/*        var sessions = parse(dirPath, options);
        callback(null, sessions)*/
    }

    /**
     * 解析saz文件的主要逻辑，主要是去解析saz解压出来的请求文件和响应文件;处理的逻辑主要是使用分开处理，先处理全部的request再处理相应的response，因为文件是相对应的
     * @param dirPath 生成的解压包的路径
     * @param options 配置的对象，目前主要是指明是否要使用gunzip解压数据
     * @return 返回生成的sessions；
     */

    function parse(dirPath, options) {

        var files = fs.readdirSync(dirPath + '/raw')
        var c_files = files.filter(function(ele) {
            return ele.indexOf('_c.txt') !== -1;
        })
        var s_files = files.filter(function(ele) {
            return ele.indexOf('_s.txt') !== -1
        })
        var sessions = {};
        //匹配出文件名里面的序号，同时去掉先导0
        var c_numReg = /[0]*([0-9]+)_c.txt/
        var s_numReg = /[0]*([0-9]+)_s.txt/
        for (var i = 0, len = c_files.length; i < len; i++) {
            var c_num = c_files[i].match(c_numReg)[1];
            sessions[c_num] = {
                request: {},
                response: {}
            }
            sessions[c_num].request = parseCFileData(dirPath + '/raw/' + c_files[i], options);
        }
        for (var i = 0, len = s_files.length; i < len; i++) {
            var s_num = s_files[i].match(s_numReg)[1];
            sessions[s_num].response = parseSFileData(dirPath + '/raw/' + s_files[i], options)
        }
        return sessions;
    }

    function headerSplit(header) {
        return header.split(': ');
    }

    function parseCFileData(filePath, options) {
        var request = {},
            rawData = fs.readFileSync(filePath).toString(),
            splittedHeaders = rawData.split(lineBreak + lineBreak)[0].split(lineBreak),
            firstLine = splittedHeaders.shift(),
            headersWithoutFStatus = splittedHeaders,
            headersArray = headersWithoutFStatus.map(headerSplit),
            headers = _.zipObject(headersArray),
            urlData;
        urlData = parseRequestUrlData(firstLine);
        _.merge(request, urlData);
        request.headers = headers;
        return request;
    }

    function parseSFileData(filePath, options) {
        var response = {},
            rawDataArray = fs.readFileSync(filePath).toString().split(lineBreak + lineBreak),
            splittedHeaders = rawDataArray[0].split(lineBreak),
            firstLine = splittedHeaders.shift(),
            headersWithoutFStatus = splittedHeaders,
            headersArray = headersWithoutFStatus.map(headerSplit),
            headers = _.zipObject(headersArray),
            urlData,
            contentEncoding,
            transferEncoding;
        urlData = parseResponseUrlData(firstLine);
        _.merge(response, urlData);
        response.headers = headers;
        //处理content的内容
        contentEncoding = headers['Content-Encoding']
        transferEncoding = headers['Transfer-Encoding']
        if (contentEncoding === 'gzip' && transferEncoding === 'chunked' && options.useGunzip === true) {
            //处理的方式主要是先得出所有chunks的长度数组，再根据长度数据使用read来每次获取相应的二进制长度内容，形成一个内容数组；最后将形成的二进制buffer数组用gunzip进行解析得到原结果；
            var chunksSize = getChunksSize(rawDataArray[1]);
            chunksSize.pop();
            //循环处理  
            var i,
                len = chunksSize.length,
                chunks = [],
                curSize = 0,
                startPos = getStrByteSize(rawDataArray[0]) + getStrByteSize(lineBreak + lineBreak), //这个是报文头的长度加止两个回车换行
                fd = fs.openSync(filePath, 'r'),
                contentSize;

            for(i = 0; i < len; i++) {
                startPos += getStrByteSize(chunksSize[i]) + getStrByteSize(lineBreak); //这个是当前chunk的长度数据所占的byte加止一个回车换行；因为其长度数值是不包含长度所占行的回车换行和内容的回车换行的
                contentSize = parseInt(chunksSize[i], 16); //将十六进制长度转成对应的十进制
                var buffer = new Buffer(contentSize);
                fs.readSync(fd, buffer, 0, contentSize, startPos)
                startPos += parseInt(chunksSize[i], 16) + getStrByteSize(lineBreak); //这里要记得加上一个回车换行
                chunks.push(buffer)
            }

            var buffer = Buffer.concat(chunks);
            content = zlib.gunzipSync(buffer).toString()
        } else {
            var content = rawDataArray[1]
        }
        response.content = content;
        return response;
    }


    function getChunksSize(rawData) {
        var arr = rawData.split('\r\n'),
            chunksSize = [],
            isPreChunk = false; //用于记录上一个字段是不是chunk字段，因为要防止出现内容的格式与chunk长度的格式一样，也就是内容符合十六进制而且以\r\n结束
        for (var i = 0; i < arr.length; i++) {
            if (isHexStr(arr[i]) && !isPreChunk) {
                chunksSize.push(arr[i]);
                isPreChunk = true;
            } else {
                isPreChunk = false;
            }
        }
        return chunksSize;
    }

    // 0到9是48-57; a-f是97-102; 确保数据是一个十六进制的数据；
    function isHexStr(str) {
        var i, len, code
        for (i = 0, len = str.length; i < len; i++) {
            code = str.charCodeAt(i);
            if ((code >= 48 && code <= 57) || (code >= 97 && code <= 102)) {
                continue;
            } else {
                return false;
            }
        }
        return true;
    }

    function parseRequestUrlData(urlData) {
        var arr = urlData.split(' ');
        return {
            method: arr[0],
            url: arr[1],
            protocol: arr[2]
        };
    }

    function parseResponseUrlData(urlData) {
        var arr = urlData.split(' ');
        return {
            protocol: arr[0],
            statusCode: arr[1],
            status: arr[2]
        };
    }

    function parseGzipData(filePath, contentSize, startPos) {
        var fd = fs.openSync(filePath, 'r'),
            buffer = new Buffer(contentSize),
            content;
        fs.readSync(fd, buffer, 0, contentSize, startPos);
        try {

            fs.writeFileSync('C:\\Users\\qinkaihuang\\Desktop\\areyou.txt', buffer)
                //content = zlib.gunzipSync(buffer).toString();
            return content;
        } catch (err) {
            console.log(err)
            throw { type: '解析gzip数据出错', err: err }
        }
    }

    //Utf-8编码下的长度统计
    function getStrByteSize(str, charset) {
        var total = 0,
            charCode,
            i,
            len;
        for (i = 0, len = str.length; i < len; i++) {
            charCode = str.charCodeAt(i);
            if (charCode <= 0x007f) {
                total += 1;
            } else if (charCode <= 0x07ff) {
                total += 2;
            } else if (charCode <= 0xffff) {
                total += 3;
            } else {
                total += 4;
            }
        }
        return total;
    }
}

module.exports = parser;
