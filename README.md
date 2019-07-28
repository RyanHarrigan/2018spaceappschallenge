Discover Earth
=====

**This repo was born during the 2018 NASA Space Apps Challenge. It borrows heavily from [cambecc's 'earth' repo](https://github.com/cambecc/earth). Thank you cambecc!**

This node.js application presents [NASA's image API details](https://images-api.nasa.gov/)  wherever a  user clicks on a land entity. A live demo with  24-hour updated wind charts can be found [here] (https://discoverearth.changeprogramming.com/). 

**NOTE: the location of `dev-server.js` has changed from `{repository}/server/` to `{repository}/`**

"earth" is a project to visualize global weather conditions.

A customized instance of "earth" is available at http://earth.nullschool.net.

"earth" is a personal project I've used to learn javascript and browser programming, and is based on the earlier
[Tokyo Wind Map](https://github.com/cambecc/air) project.  Feedback and contributions are welcome! ...especially
those that clarify accepted best practices.

building and launching
----------------------

After installing node.js and npm, clone "earth" and install dependencies:

    `git clone https://github.com/RyanHarrigan/2018spaceappschallenge earth`
    `cd earth`
    `npm install`

Next, launch the development web server:

    `node dev-server.js 8080`

Finally, point your browser to:

    http://localhost:8080

The server acts as a stand-in for static S3 bucket hosting and so contains almost no server-side logic. It
serves all files located in the `earth/public` directory. See `public/index.html` and `public/libs/earth/*.js`
for the main entry points. Data files are located in the `public/data` directory, and there is one sample
weather layer located at `data/weather/current`.

*For Ubuntu, Mint, and elementary OS, use `nodejs` instead of `node` instead due to a [naming conflict](https://github.com/joyent/node/wiki/Installing-Node.js-via-package-manager#ubuntu-mint-elementary-os).

getting weather data
--------------------

Weather data is produced by the [Global Forecast System](http://en.wikipedia.org/wiki/Global_Forecast_System) (GFS),
operated by the US National Weather Service. Forecasts are produced four times daily and made available for
download from [NOMADS](http://nomads.ncep.noaa.gov/). The files are in [GRIB2](http://en.wikipedia.org/wiki/GRIB)
format and contain over [300 records](http://www.nco.ncep.noaa.gov/pmb/products/gfs/gfs.t00z.pgrbf00.grib2.shtml).
We need only a few of these records to visualize wind data at a particular isobar. The following commands download
the 1000 hPa wind vectors and convert them to JSON format using the [grib2json](https://github.com/cambecc/grib2json)
utility:

    YYYYMMDD=`date +%Y%m%d`; curl "https://nomads.ncep.noaa.gov/cgi-bin/filter_gfs_1p00.pl?file=gfs.t00z.pgrb2.1p00.f000&lev_10_m_above_ground=on&var_UGRD=on&var_VGRD=on&leftlon=0&rightlon=360&toplat=90&bottomlat=-90&dir=%2Fgfs.${YYYYMMDD}%2F00" -o gfs.t00z.pgrb2.1p00.f000
    grib2json -d -n -o current-wind-surface-level-gfs-1.0.json gfs.t00z.pgrb2.1p00.f000
    cp current-wind-surface-level-gfs-1.0.json <earth-git-repository>/public/data/weather/current

font subsetting
---------------

This project uses [M+ FONTS](http://mplus-fonts.sourceforge.jp/). To reduce download size, a subset font is
constructed out of the unique characters utilized by the site. See the `earth/server/font/findChars.js` script
for details. Font subsetting is performed by the [M+Web FONTS Subsetter](http://mplus.font-face.jp/), and
the resulting font is placed in `earth/public/styles`.

[Mono Social Icons Font](http://drinchev.github.io/monosocialiconsfont/) is used for scalable, social networking
icons. This can be subsetted using [Font Squirrel's WebFont Generator](http://www.fontsquirrel.com/tools/webfont-generator).

implementation notes
--------------------

Building this project required solutions to some interesting problems. Here are a few:

   * The GFS grid has a resolution of 1°. Intermediate points are interpolated in the browser using [bilinear
     interpolation](http://en.wikipedia.org/wiki/Bilinear_interpolation). This operation is quite costly.
   * Each type of projection warps and distorts the earth in a particular way, and the degree of distortion must
     be calculated for each point (x, y) to ensure wind particle paths are rendered correctly. For example,
     imagine looking at a globe where a wind particle is moving north from the equator. If the particle starts
     from the center, it will trace a path straight up. However, if the particle starts from the globe's edge,
     it will trace a path that curves toward the pole. [Finite difference approximations](http://gis.stackexchange.com/a/5075/23451)
     are used to estimate this distortion during the interpolation process.
   * The SVG map of the earth is overlaid with an HTML5 Canvas, where the animation is drawn. Another HTML5
     Canvas sits on top and displays the colored overlay. Both canvases must know where the boundaries of the
     globe are rendered by the SVG engine, but this pixel-for-pixel information is difficult to obtain directly
     from the SVG elements. To workaround this problem, the globe's bounding sphere is re-rendered to a
     detached Canvas element, and the Canvas' pixels operate as a mask to distinguish points that lie outside
     and inside the globe's bounds.
   * Most configuration options are persisted in the hash fragment to allow deep linking and back-button
     navigation. I use a [backbone.js Model](http://backbonejs.org/#Model) to represent the configuration.
     Changes to the model persist to the hash fragment (and vice versa) and trigger "change" events which flow to
     other components.
   * Components use [backbone.js Events](http://backbonejs.org/#Events) to trigger changes in other downstream
     components. For example, downloading a new layer produces a new grid, which triggers reinterpolation, which
     in turn triggers a new particle animator. Events flow through the page without much coordination,
     sometimes causing visual artifacts that (usually) quickly disappear.
   * There's gotta be a better way to do this. Any ideas?

inspiration
-----------

The awesome [hint.fm wind map](http://hint.fm/wind/) and [D3.js visualization library](http://d3js.org) provided
the main inspiration for this project.
