cd /w
for pair in "0.53 0.50 0.53 0.56" "4.00 3.97 4.00 4.03" "6.55 6.52 6.55 6.58"; do
  set -- $pair; b=$1; shift
  for f in "$@"; do
    ffmpeg -v error -y -f lavfi -i color=black:s=1080x1920:r=100:d=10 -vf "subtitles=sample.ass:fontsdir=fonts" -ss $f -frames:v 1 /tmp/f.png
    p=$(ffmpeg -hide_banner -i out/build/default-cap-$b.png -i /tmp/f.png -filter_complex "[0:v]format=rgb24[a];[1:v]format=rgb24[b];[a][b]psnr" -f null - 2>&1 | grep -o 'average:[^ ]*')
    echo "browser t=$b vs ffmpeg t=$f  $p"
  done
done
ffmpeg -v error -y -i out/compare/side-0.56.png -i out/compare/side-4.00.png -i out/compare/side-6.55.png -filter_complex "[0][1][2]vstack=3,scale=1080:-1" out/compare/side-by-side.png
ffmpeg -v verbose -y -f lavfi -i color=black:s=1080x1920:r=100:d=1 -vf "subtitles=sample.ass:fontsdir=fonts" -ss 0.6 -frames:v 1 /tmp/x.png 2>&1 | grep -i -E 'font|glyph' | head -5
