var parser = require('./'),
	fs = require('fs')

parser('./test/tree.saz', {useGunzip: true}, function(err, sessions) {
	if(err) {
		console.log(err)
	} else {
		fs.writeFileSync('./result.txt', sessions[1].response.content)
	}
});