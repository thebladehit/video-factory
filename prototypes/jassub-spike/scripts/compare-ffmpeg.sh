set -e
cd /w
for t in 0.20 0.53 0.56 1.50 3.30 3.55 4.00 5.50 6.55 7.50 9.60; do
  ffmpeg -v error -y -f lavfi -i color=black:s=1080x1920:r=100:d=10 -vf "subtitles=sample.ass:fontsdir=fonts" -ss $t -frames:v 1 out/ffmpeg/ff-$t.png
  ffmpeg -v error -y -i out/build/default-cap-$t.png -i out/ffmpeg/ff-$t.png -filter_complex "[0][1]hstack" out/compare/side-$t.png
  psnr=$(ffmpeg -hide_banner -i out/build/default-cap-$t.png -i out/ffmpeg/ff-$t.png -filter_complex "[0:v]format=rgb24[a];[1:v]format=rgb24[b];[a][b]psnr" -f null - 2>&1 | grep -o 'average:[^ ]*')
  echo "t=$t $psnr"
done
