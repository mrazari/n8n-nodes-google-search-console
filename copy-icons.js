const fs = require('fs');
const path = require('path');

const source = path.join(__dirname, 'src/nodes/GoogleSearchConsole/googlesearchconsole.svg');
const destinationDir = path.join(__dirname, 'dist/nodes/GoogleSearchConsole');
const destination = path.join(destinationDir, 'googlesearchconsole.svg');

// اگر فولدر مقصد وجود نداره، بسازش
if (!fs.existsSync(destinationDir)) {
	fs.mkdirSync(destinationDir, { recursive: true });
}

// کپی فایل
fs.copyFileSync(source, destination);
console.log('✅ Icon copied to dist/nodes/GoogleSearchConsole/');
