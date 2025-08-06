const { src, dest, series } = require('gulp');
const icons = require('./gulpfile.icons'); // اگه نیاز داری
const path = require('path');

// کپی دقیق svg نودها
function copyNodeIcons() {
  return src('src/nodes/GoogleSearchConsole/googlesearchconsole.svg', { base: 'src/nodes' })
    .pipe(dest('dist/nodes'));
}

exports.build = series(
  icons.buildIcons,
  copyNodeIcons
);
