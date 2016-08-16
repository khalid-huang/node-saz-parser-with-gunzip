### 使用方法
	+ 主要是可以通过useGunzip参数来确定是否要使用gunzip对数据进行解压操作，如果不传入这个参数的话，那么默认是直接将gzip压缩数据作为结果返回的。
	```
	var parser = require('./'),
		fs = require('fs')

	parser('./test/tree.saz', {useGunzip: true}, function(err, sessions) {
		if(err) {
			console.log(err)
		} else {
			//do something with sessions
		}
	});
	```