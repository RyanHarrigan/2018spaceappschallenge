/**
 * earth - a project to visualize global air data.
 *
 * Copyright (c) 2014 Cameron Beccario
 * The MIT License - http://opensource.org/licenses/MIT
 *
 * https://github.com/cambecc/earth
 */

var globe, dispatch;
var isRandomizing = false;
var modalContent = {
  title: "",
  body: "",
  images: [],
  video: ""
};

(function() {
  "use strict";

  var SECOND = 1000;
  var MINUTE = 60 * SECOND;
  var HOUR = 60 * MINUTE;
  var MAX_TASK_TIME = 100; // amount of time before a task yields control (millis)
  var MIN_SLEEP_TIME = 25; // amount of time a task waits before resuming (millis)
  var MIN_MOVE = 4; // slack before a drag operation beings (pixels)
  var MOVE_END_WAIT = 1000; // time to wait for a move operation to be considered done (millis)

  var OVERLAY_ALPHA = Math.floor(0.4 * 255); // overlay transparency (on scale [0, 255])
  var INTENSITY_SCALE_STEP = 10; // step size of particle intensity color scale
  var MAX_PARTICLE_AGE = 100; // max number of frames a particle is drawn before regeneration
  var PARTICLE_LINE_WIDTH = 1.0; // line width of a drawn particle
  var PARTICLE_MULTIPLIER = 7; // particle count scalar (completely arbitrary--this values looks nice)
  var PARTICLE_REDUCTION = 0.75; // reduce particle count to this much of normal for mobile devices
  var FRAME_RATE = 40; // desired milliseconds per frame

  var NULL_WIND_VECTOR = [NaN, NaN, null]; // singleton for undefined location outside the vector field [u, v, mag]
  var HOLE_VECTOR = [NaN, NaN, null]; // singleton that signifies a hole in the vector field
  var TRANSPARENT_BLACK = [0, 0, 0, 0]; // singleton 0 rgba
  var REMAINING = "▫▫▫▫▫▫▫▫▫▫▫▫▫▫▫▫▫▫▫▫▫▫"; // glyphs for remaining progress bar
  var COMPLETED = "▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪"; // glyphs for completed progress bar

  var view = µ.view();
  var log = µ.log();

  /**
   * An object to display various types of messages to the user.
   */
  var report = (function() {
    var s = d3.select("#status"),
      p = d3.select("#progress"),
      total = REMAINING.length;
    return {
      status: function(msg) {
        return s.classed("bad") ? s : s.text(msg); // errors are sticky until reset
      },
      error: function(err) {
        var msg = err.status ? err.status + " " + err.message : err;
        switch (err.status) {
          case -1:
            msg = "Server Down";
            break;
          case 404:
            msg = "No Data";
            break;
        }
        log.error(err);
        return s.classed("bad", true).text(msg);
      },
      reset: function() {
        return s.classed("bad", false).text("");
      },
      progress: function(amount) {
        // amount of progress to report in the range [0, 1]
        if (0 <= amount && amount < 1) {
          var i = Math.ceil(amount * total);
          var bar = COMPLETED.substr(0, i) + REMAINING.substr(0, total - i);
          return p.classed("invisible", false).text(bar);
        }
        return p.classed("invisible", true).text(""); // progress complete
      }
    };
  })();

  function newAgent() {
    return µ.newAgent().on({ reject: report.error, fail: report.error });
  }

  // Construct the page's main internal components:

  var configuration = µ.buildConfiguration(globes, products.overlayTypes); // holds the page's current configuration settings
  var inputController = buildInputController(); // interprets drag/zoom operations
  var meshAgent = newAgent(); // map data for the earth
  var globeAgent = newAgent(); // the model of the globe
  var gridAgent = newAgent(); // the grid of weather data
  var rendererAgent = newAgent(); // the globe SVG renderer
  var fieldAgent = newAgent(); // the interpolated wind vector field
  var animatorAgent = newAgent(); // the wind animator
  var overlayAgent = newAgent(); // color overlay over the animation

  /**
   * The input controller is an object that translates move operations (drag and/or zoom) into mutations of the
   * current globe's projection, and emits events so other page components can react to these move operations.
   *
   * D3's built-in Zoom behavior is used to bind to the document's drag/zoom events, and the input controller
   * interprets D3's events as move operations on the globe. This method is complicated due to the complex
   * event behavior that occurs during drag and zoom.
   *
   * D3 move operations usually occur as "zoomstart" -> ("zoom")* -> "zoomend" event chain. During "zoom" events
   * the scale and mouse may change, implying a zoom or drag operation accordingly. These operations are quite
   * noisy. What should otherwise be one smooth continuous zoom is usually comprised of several "zoomstart" ->
   * "zoom" -> "zoomend" event chains. A debouncer is used to eliminate the noise by waiting a short period of
   * time to ensure the user has finished the move operation.
   *
   * The "zoom" events may not occur; a simple click operation occurs as: "zoomstart" -> "zoomend". There is
   * additional logic for other corner cases, such as spurious drags which move the globe just a few pixels
   * (most likely unintentional), and the tendency for some touch devices to issue events out of order:
   * "zoom" -> "zoomstart" -> "zoomend".
   *
   * This object emits clean "moveStart" -> ("move")* -> "moveEnd" events for move operations, and "click" events
   * for normal clicks. Spurious moves emit no events.
   */
  function buildInputController() {
    var op = null;
    globe = null;

    /**
     * @returns {Object} an object to represent the state for one move operation.
     */
    function newOp(startMouse, startScale) {
      return {
        type: "click", // initially assumed to be a click operation
        startMouse: startMouse,
        startScale: startScale,
        manipulator: globe.manipulator(startMouse, startScale)
      };
    }

    var zoom = d3.behavior
      .zoom()
      .on("zoomstart", function() {
        op = op || newOp(d3.mouse(this), zoom.scale()); // a new operation begins
      })
      .on("zoom", function() {
        var currentMouse = d3.mouse(this),
          currentScale = d3.event.scale;
        op = op || newOp(currentMouse, 1); // Fix bug on some browsers where zoomstart fires out of order.
        if (op.type === "click" || op.type === "spurious") {
          var distanceMoved = µ.distance(currentMouse, op.startMouse);
          if (currentScale === op.startScale && distanceMoved < MIN_MOVE) {
            // to reduce annoyance, ignore op if mouse has barely moved and no zoom is occurring
            op.type = distanceMoved > 0 ? "click" : "spurious";
            return;
          }
          dispatch.trigger("moveStart");
          op.type = "drag";
        }
        if (currentScale != op.startScale) {
          op.type = "zoom"; // whenever a scale change is detected, (stickily) switch to a zoom operation
        }

        // when zooming, ignore whatever the mouse is doing--really cleans up behavior on touch devices
        op.manipulator.move(
          op.type === "zoom" ? null : currentMouse,
          currentScale
        );
        dispatch.trigger("move");
      })
      .on("zoomend", function() {
        op.manipulator.end();
        if (op.type === "click") {
          dispatch.trigger(
            "click",
            op.startMouse,
            globe.projection.invert(op.startMouse) || []
          );
        } else if (op.type !== "spurious") {
          signalEnd();
        }
        op = null; // the drag/zoom/click operation is over
      });

    var signalEnd = _.debounce(function() {
      if (!op || (op.type !== "drag" && op.type !== "zoom")) {
        configuration.save(
          { orientation: globe.orientation() },
          { source: "moveEnd" }
        );
        dispatch.trigger("moveEnd");
      }
    }, MOVE_END_WAIT); // wait for a bit to decide if user has stopped moving the globe

    d3.select("#display").call(zoom);
    d3.select("#show-location").on("click", function() {
      if (navigator.geolocation) {
        report.status("Finding current position...");
        navigator.geolocation.getCurrentPosition(function(pos) {
          report.status("");
          var coord = [pos.coords.longitude, pos.coords.latitude],
            rotate = globe.locate(coord);
          if (rotate) {
            globe.projection.rotate(rotate);
            configuration.save({ orientation: globe.orientation() }); // triggers reorientation
          }
          dispatch.trigger("click", globe.projection(coord), coord);
        }, log.error);
      }
    });

    function reorient() {
      var options = arguments[3] || {};
      if (!globe || options.source === "moveEnd") {
        // reorientation occurred because the user just finished a move operation, so globe is already
        // oriented correctly.
        return;
      }
      dispatch.trigger("moveStart");
      globe.orientation(configuration.get("orientation"), view);
      zoom.scale(globe.projection.scale());
      dispatch.trigger("moveEnd");
    }

    dispatch = _.extend(
      {
        globe: function(_) {
          if (_) {
            globe = _;
            zoom.scaleExtent(globe.scaleExtent());
            reorient();
          }
          return _ ? this : globe;
        }
      },
      Backbone.Events
    );
    return dispatch.listenTo(configuration, "change:orientation", reorient);
  }

  /**
   * @param resource the GeoJSON resource's URL
   * @returns {Object} a promise for GeoJSON topology features: {boundaryLo:, boundaryHi:}
   */
  function buildMesh(resource) {
    var cancel = this.cancel;
    report.status("Downloading...");
    return µ.loadJson(resource).then(function(topo) {
      if (cancel.requested) return null;
      log.time("building meshes");
      var o = topo.objects;
      var coastLo = topojson.feature(
        topo,
        µ.isMobile() ? o.coastline_tiny : o.coastline_110m
      );
      var coastHi = topojson.feature(
        topo,
        µ.isMobile() ? o.coastline_110m : o.coastline_50m
      );
      var lakesLo = topojson.feature(
        topo,
        µ.isMobile() ? o.lakes_tiny : o.lakes_110m
      );
      var lakesHi = topojson.feature(
        topo,
        µ.isMobile() ? o.lakes_110m : o.lakes_50m
      );
      log.timeEnd("building meshes");
      return {
        coastLo: coastLo,
        coastHi: coastHi,
        lakesLo: lakesLo,
        lakesHi: lakesHi
      };
    });
  }

  /**
   * @param {String} projectionName the desired projection's name.
   * @returns {Object} a promise for a globe object.
   */
  function buildGlobe(projectionName) {
    var builder = globes.get(projectionName);
    if (!builder) {
      return when.reject("Unknown projection: " + projectionName);
    }
    return when(builder(view));
  }

  // Some hacky stuff to ensure only one download can be in progress at a time.
  var downloadsInProgress = 0;

  function buildGrids() {
    report.status("Downloading...");
    log.time("build grids");
    // UNDONE: upon failure to load a product, the unloaded product should still be stored in the agent.
    //         this allows us to use the product for navigation and other state.
    var cancel = this.cancel;
    downloadsInProgress++;
    var loaded = when.map(
      products.productsFor(configuration.attributes),
      function(product) {
        return product.load(cancel);
      }
    );
    return when
      .all(loaded)
      .then(function(products) {
        log.time("build grids");
        return {
          primaryGrid: products[0],
          overlayGrid: products[1] || products[0]
        };
      })
      .ensure(function() {
        downloadsInProgress--;
      });
  }

  /**
   * Modifies the configuration to navigate to the chronologically next or previous data layer.
   */
  function navigate(step) {
    if (downloadsInProgress > 0) {
      log.debug("Download in progress--ignoring nav request.");
      return;
    }
    var next = gridAgent.value().primaryGrid.navigate(step);
    if (next) {
      configuration.save(µ.dateToConfig(next));
    }
  }

  function buildRenderer(mesh, globe) {
    if (!mesh || !globe) return null;

    report.status("Rendering Globe...");
    log.time("rendering map");

    // UNDONE: better way to do the following?
    var dispatch = _.clone(Backbone.Events);
    if (rendererAgent._previous) {
      rendererAgent._previous.stopListening();
    }
    rendererAgent._previous = dispatch;

    // First clear map and foreground svg contents.
    µ.removeChildren(d3.select("#map").node());
    µ.removeChildren(d3.select("#foreground").node());
    // Create new map svg elements.
    globe.defineMap(d3.select("#map"), d3.select("#foreground"));

    var path = d3.geo
      .path()
      .projection(globe.projection)
      .pointRadius(7);
    var coastline = d3.select(".coastline");
    var lakes = d3.select(".lakes");
    d3.selectAll("path").attr("d", path); // do an initial draw -- fixes issue with safari

    function drawLocationMark(point, coord) {
      // show the location on the map if defined
      if (
        fieldAgent.value() &&
        !fieldAgent.value().isInsideBoundary(point[0], point[1])
      ) {
        // UNDONE: Sometimes this is invoked on an old, released field, because new one has not been
        //         built yet, causing the mark to not get drawn.
        return; // outside the field boundary, so ignore.
      }
      if (coord && _.isFinite(coord[0]) && _.isFinite(coord[1])) {
        var mark = d3.select(".location-mark");
        if (!mark.node()) {
          mark = d3
            .select("#foreground")
            .append("path")
            .attr("class", "location-mark");
        }
        mark.datum({ type: "Point", coordinates: coord }).attr("d", path);
      }
    }

    // Draw the location mark if one is currently visible.
    if (activeLocation.point && activeLocation.coord) {
      drawLocationMark(activeLocation.point, activeLocation.coord);
    }

    // Throttled draw method helps with slow devices that would get overwhelmed by too many redraw events.
    var REDRAW_WAIT = 5; // milliseconds
    var doDraw_throttled = _.throttle(doDraw, REDRAW_WAIT, { leading: false });

    function doDraw() {
      d3.selectAll("path").attr("d", path);
      rendererAgent.trigger("redraw");
      doDraw_throttled = _.throttle(doDraw, REDRAW_WAIT, { leading: false });
    }

    // Attach to map rendering events on input controller.
    dispatch.listenTo(inputController, {
      moveStart: function() {
        coastline.datum(mesh.coastLo);
        lakes.datum(mesh.lakesLo);
        rendererAgent.trigger("start");
      },
      move: function() {
        doDraw_throttled();
      },
      moveEnd: function() {
        coastline.datum(mesh.coastHi);
        lakes.datum(mesh.lakesHi);
        d3.selectAll("path").attr("d", path);
        rendererAgent.trigger("render");
      },
      click: drawLocationMark
    });

    // Finally, inject the globe model into the input controller. Do it on the next event turn to ensure
    // renderer is fully set up before events start flowing.
    when(true).then(function() {
      inputController.globe(globe);
    });

    log.timeEnd("rendering map");
    return "ready";
  }

  function createMask(globe) {
    if (!globe) return null;

    log.time("render mask");

    // Create a detached canvas, ask the model to define the mask polygon, then fill with an opaque color.
    var width = view.width,
      height = view.height;
    var canvas = d3
      .select(document.createElement("canvas"))
      .attr("width", width)
      .attr("height", height)
      .node();
    var context = globe.defineMask(canvas.getContext("2d"));
    context.fillStyle = "rgba(255, 0, 0, 1)";
    context.fill();
    // d3.select("#display").node().appendChild(canvas);  // make mask visible for debugging

    var imageData = context.getImageData(0, 0, width, height);
    var data = imageData.data; // layout: [r, g, b, a, r, g, b, a, ...]
    log.timeEnd("render mask");
    return {
      imageData: imageData,
      isVisible: function(x, y) {
        var i = (y * width + x) * 4;
        return data[i + 3] > 0; // non-zero alpha means pixel is visible
      },
      set: function(x, y, rgba) {
        var i = (y * width + x) * 4;
        data[i] = rgba[0];
        data[i + 1] = rgba[1];
        data[i + 2] = rgba[2];
        data[i + 3] = rgba[3];
        return this;
      }
    };
  }

  function createField(columns, bounds, mask) {
    /**
     * @returns {Array} wind vector [u, v, magnitude] at the point (x, y), or [NaN, NaN, null] if wind
     *          is undefined at that point.
     */
    function field(x, y) {
      var column = columns[Math.round(x)];
      return (column && column[Math.round(y)]) || NULL_WIND_VECTOR;
    }

    /**
     * @returns {boolean} true if the field is valid at the point (x, y)
     */
    field.isDefined = function(x, y) {
      return field(x, y)[2] !== null;
    };

    /**
     * @returns {boolean} true if the point (x, y) lies inside the outer boundary of the vector field, even if
     *          the vector field has a hole (is undefined) at that point, such as at an island in a field of
     *          ocean currents.
     */
    field.isInsideBoundary = function(x, y) {
      return field(x, y) !== NULL_WIND_VECTOR;
    };

    // Frees the massive "columns" array for GC. Without this, the array is leaked (in Chrome) each time a new
    // field is interpolated because the field closure's context is leaked, for reasons that defy explanation.
    field.release = function() {
      columns = [];
    };

    field.randomize = function(o) {
      // UNDONE: this method is terrible
      var x, y;
      var safetyNet = 0;
      do {
        x = Math.round(_.random(bounds.x, bounds.xMax));
        y = Math.round(_.random(bounds.y, bounds.yMax));
      } while (!field.isDefined(x, y) && safetyNet++ < 30);
      o.x = x;
      o.y = y;
      return o;
    };

    field.overlay = mask.imageData;

    return field;
  }

  /**
   * Calculate distortion of the wind vector caused by the shape of the projection at point (x, y). The wind
   * vector is modified in place and returned by this function.
   */
  function distort(projection, λ, φ, x, y, scale, wind) {
    var u = wind[0] * scale;
    var v = wind[1] * scale;
    var d = µ.distortion(projection, λ, φ, x, y);

    // Scale distortion vectors by u and v, then add.
    wind[0] = d[0] * u + d[2] * v;
    wind[1] = d[1] * u + d[3] * v;
    return wind;
  }

  function interpolateField(globe, grids) {
    if (!globe || !grids) return null;

    var mask = createMask(globe);
    var primaryGrid = grids.primaryGrid;
    var overlayGrid = grids.overlayGrid;

    log.time("interpolating field");
    var d = when.defer(),
      cancel = this.cancel;

    var projection = globe.projection;
    var bounds = globe.bounds(view);
    // How fast particles move on the screen (arbitrary value chosen for aesthetics).
    var velocityScale = bounds.height * primaryGrid.particles.velocityScale;

    var columns = [];
    var point = [];
    var x = bounds.x;
    var interpolate = primaryGrid.interpolate;
    var overlayInterpolate = overlayGrid.interpolate;
    var hasDistinctOverlay = primaryGrid !== overlayGrid;
    var scale = overlayGrid.scale;

    function interpolateColumn(x) {
      var column = [];
      for (var y = bounds.y; y <= bounds.yMax; y += 2) {
        if (mask.isVisible(x, y)) {
          point[0] = x;
          point[1] = y;
          var coord = projection.invert(point);
          var color = TRANSPARENT_BLACK;
          var wind = null;
          if (coord) {
            var λ = coord[0],
              φ = coord[1];
            if (isFinite(λ)) {
              wind = interpolate(λ, φ);
              var scalar = null;
              if (wind) {
                wind = distort(projection, λ, φ, x, y, velocityScale, wind);
                scalar = wind[2];
              }
              if (hasDistinctOverlay) {
                scalar = overlayInterpolate(λ, φ);
              }
              if (µ.isValue(scalar)) {
                color = scale.gradient(scalar, OVERLAY_ALPHA);
              }
            }
          }
          column[y + 1] = column[y] = wind || HOLE_VECTOR;
          mask
            .set(x, y, color)
            .set(x + 1, y, color)
            .set(x, y + 1, color)
            .set(x + 1, y + 1, color);
        }
      }
      columns[x + 1] = columns[x] = column;
    }

    report.status("");

    (function batchInterpolate() {
      try {
        if (!cancel.requested) {
          var start = Date.now();
          while (x < bounds.xMax) {
            interpolateColumn(x);
            x += 2;
            if (Date.now() - start > MAX_TASK_TIME) {
              // Interpolation is taking too long. Schedule the next batch for later and yield.
              report.progress((x - bounds.x) / (bounds.xMax - bounds.x));
              setTimeout(batchInterpolate, MIN_SLEEP_TIME);
              return;
            }
          }
        }
        d.resolve(createField(columns, bounds, mask));
      } catch (e) {
        d.reject(e);
      }
      report.progress(1); // 100% complete
      log.timeEnd("interpolating field");
    })();

    return d.promise;
  }

  function animate(globe, field, grids) {
    if (!globe || !field || !grids) return;

    var cancel = this.cancel;
    var bounds = globe.bounds(view);
    // maxIntensity is the velocity at which particle color intensity is maximum
    var colorStyles = µ.windIntensityColorScale(
      INTENSITY_SCALE_STEP,
      grids.primaryGrid.particles.maxIntensity
    );
    var buckets = colorStyles.map(function() {
      return [];
    });
    var particleCount = Math.round(bounds.width * PARTICLE_MULTIPLIER);
    if (µ.isMobile()) {
      particleCount *= PARTICLE_REDUCTION;
    }
    var fadeFillStyle = µ.isFF()
      ? "rgba(0, 0, 0, 0.95)"
      : "rgba(0, 0, 0, 0.97)"; // FF Mac alpha behaves oddly

    log.debug("particle count: " + particleCount);
    var particles = [];
    for (var i = 0; i < particleCount; i++) {
      particles.push(field.randomize({ age: _.random(0, MAX_PARTICLE_AGE) }));
    }

    function evolve() {
      buckets.forEach(function(bucket) {
        bucket.length = 0;
      });
      particles.forEach(function(particle) {
        if (particle.age > MAX_PARTICLE_AGE) {
          field.randomize(particle).age = 0;
        }
        var x = particle.x;
        var y = particle.y;
        var v = field(x, y); // vector at current position
        var m = v[2];
        if (m === null) {
          particle.age = MAX_PARTICLE_AGE; // particle has escaped the grid, never to return...
        } else {
          var xt = x + v[0];
          var yt = y + v[1];
          if (field.isDefined(xt, yt)) {
            // Path from (x,y) to (xt,yt) is visible, so add this particle to the appropriate draw bucket.
            particle.xt = xt;
            particle.yt = yt;
            buckets[colorStyles.indexFor(m)].push(particle);
          } else {
            // Particle isn't visible, but it still moves through the field.
            particle.x = xt;
            particle.y = yt;
          }
        }
        particle.age += 1;
      });
    }

    var g = d3
      .select("#animation")
      .node()
      .getContext("2d");
    g.lineWidth = PARTICLE_LINE_WIDTH;
    g.fillStyle = fadeFillStyle;

    function draw() {
      // Fade existing particle trails.
      var prev = g.globalCompositeOperation;
      g.globalCompositeOperation = "destination-in";
      g.fillRect(bounds.x, bounds.y, bounds.width, bounds.height);
      g.globalCompositeOperation = prev;

      // Draw new particle trails.
      buckets.forEach(function(bucket, i) {
        if (bucket.length > 0) {
          g.beginPath();
          g.strokeStyle = colorStyles[i];
          bucket.forEach(function(particle) {
            g.moveTo(particle.x, particle.y);
            g.lineTo(particle.xt, particle.yt);
            particle.x = particle.xt;
            particle.y = particle.yt;
          });
          g.stroke();
        }
      });
    }

    (function frame() {
      try {
        if (cancel.requested) {
          field.release();
          return;
        }
        evolve();
        draw();
        setTimeout(frame, FRAME_RATE);
      } catch (e) {
        report.error(e);
      }
    })();
  }

  function drawGridPoints(ctx, grid, globe) {
    if (!grid || !globe || !configuration.get("showGridPoints")) return;

    ctx.fillStyle = "rgba(255, 255, 255, 1)";
    // Use the clipping behavior of a projection stream to quickly draw visible points.
    var stream = globe.projection.stream({
      point: function(x, y) {
        ctx.fillRect(Math.round(x), Math.round(y), 1, 1);
      }
    });
    grid.forEachPoint(function(λ, φ, d) {
      if (µ.isValue(d)) {
        stream.point(λ, φ);
      }
    });
  }

  function drawOverlay(field, overlayType) {
    if (!field) return;

    var ctx = d3
        .select("#overlay")
        .node()
        .getContext("2d"),
      grid = (gridAgent.value() || {}).overlayGrid;

    µ.clearCanvas(d3.select("#overlay").node());
    µ.clearCanvas(d3.select("#scale").node());
    if (overlayType) {
      if (overlayType !== "off") {
        ctx.putImageData(field.overlay, 0, 0);
      }
      drawGridPoints(ctx, grid, globeAgent.value());
    }

    if (grid) {
      // Draw color bar for reference.
      var colorBar = d3.select("#scale"),
        scale = grid.scale,
        bounds = scale.bounds;
      var c = colorBar.node(),
        g = c.getContext("2d"),
        n = c.width - 1;
      for (var i = 0; i <= n; i++) {
        var rgb = scale.gradient(µ.spread(i / n, bounds[0], bounds[1]), 1);
        g.fillStyle = "rgb(" + rgb[0] + "," + rgb[1] + "," + rgb[2] + ")";
        g.fillRect(i, 0, 1, c.height);
      }

      // Show tooltip on hover.
      colorBar.on("mousemove", function() {
        var x = d3.mouse(this)[0];
        var pct = µ.clamp((Math.round(x) - 2) / (n - 2), 0, 1);
        var value = µ.spread(pct, bounds[0], bounds[1]);
        var elementId =
          grid.type === "wind"
            ? "#location-wind-units"
            : "#location-value-units";
        var units = createUnitToggle(elementId, grid).value();
        colorBar.attr(
          "title",
          µ.formatScalar(value, units) + " " + units.label
        );
      });
    }
  }

  /**
   * Extract the date the grids are valid, or the current date if no grid is available.
   * UNDONE: if the grids hold unloaded products, then the date can be extracted from them.
   *         This function would simplify nicely.
   */
  function validityDate(grids) {
    // When the active layer is considered "current", use its time as now, otherwise use current time as
    // now (but rounded down to the nearest three-hour block).
    var THREE_HOURS = 3 * HOUR;
    var now = grids
      ? grids.primaryGrid.date.getTime()
      : Math.floor(Date.now() / THREE_HOURS) * THREE_HOURS;
    var parts = configuration.get("date").split("/"); // yyyy/mm/dd or "current"
    var hhmm = configuration.get("hour");
    return parts.length > 1
      ? Date.UTC(+parts[0], parts[1] - 1, +parts[2], +hhmm.substring(0, 2))
      : parts[0] === "current"
        ? now
        : null;
  }

  /**
   * Display the grid's validity date in the menu. Allow toggling between local and UTC time.
   */
  function showDate(grids) {
    var date = new Date(validityDate(grids)),
      isLocal = d3.select("#data-date").classed("local");
    var formatted = isLocal ? µ.toLocalISO(date) : µ.toUTCISO(date);
    d3.select("#data-date").text(formatted + " " + (isLocal ? "Local" : "UTC"));
    d3.select("#toggle-zone").text("⇄ " + (isLocal ? "UTC" : "Local"));
  }

  /**
   * Display the grids' types in the menu.
   */
  function showGridDetails(grids) {
    showDate(grids);
    var description = "",
      center = "";
    if (grids) {
      var langCode = d3.select("body").attr("data-lang") || "en";
      var pd = grids.primaryGrid.description(langCode),
        od = grids.overlayGrid.description(langCode);
      description = od.name + od.qualifier;
      if (grids.primaryGrid !== grids.overlayGrid) {
        // Combine both grid descriptions together with a " + " if their qualifiers are the same.
        description =
          (pd.qualifier === od.qualifier ? pd.name : pd.name + pd.qualifier) +
          " + " +
          description;
      }
      center = grids.overlayGrid.source;
    }
    d3.select("#data-layer").text(description);
    d3.select("#data-center").text(center);
  }

  /**
   * Constructs a toggler for the specified product's units, storing the toggle state on the element having
   * the specified id. For example, given a product having units ["m/s", "mph"], the object returned by this
   * method sets the element's "data-index" attribute to 0 for m/s and 1 for mph. Calling value() returns the
   * currently active units object. Calling next() increments the index.
   */
  function createUnitToggle(id, product) {
    var units = product.units,
      size = units.length;
    var index = +(d3.select(id).attr("data-index") || 0) % size;
    return {
      value: function() {
        return units[index];
      },
      next: function() {
        d3.select(id).attr("data-index", (index = (index + 1) % size));
      }
    };
  }

  /**
   * Display the specified wind value. Allow toggling between the different types of wind units.
   */
  function showWindAtLocation(wind, product) {
    var unitToggle = createUnitToggle("#location-wind-units", product),
      units = unitToggle.value();
    d3.select("#location-wind").text(µ.formatVector(wind, units));
    d3.select("#location-wind-units")
      .text(units.label)
      .on("click", function() {
        unitToggle.next();
        showWindAtLocation(wind, product);
      });
  }

  /**
   * Display the specified overlay value. Allow toggling between the different types of supported units.
   */
  function showOverlayValueAtLocation(value, product) {
    var unitToggle = createUnitToggle("#location-value-units", product),
      units = unitToggle.value();
    d3.select("#location-value").text(µ.formatScalar(value, units));
    d3.select("#location-value-units")
      .text(units.label)
      .on("click", function() {
        unitToggle.next();
        showOverlayValueAtLocation(value, product);
      });
  }

  // Stores the point and coordinate of the currently visible location. This is used to update the location
  // details when the field changes.
  var activeLocation = {};

  function populateModalContent(modalValues) {
    modalContent["body"] = modalValues["Country"];

    var media = [];
    // console.log('modalValues', modalValues);
    // console.log('modalValues[media]', modalValues['Items'] );
    // console.log('modalValues[media][0]', modalValues['Items'][0] );

    var previewImage = modalValues["Items"][0]["multimedia_url"];
    var previewDescription = modalValues["Items"][0]["description"];
    // console.log('previewImage', previewImage);

    media.push(previewImage); // push only the first image

    modalContent["title"] = modalValues["Country"];
    modalContent["images"] = media;
    modalContent["body"] = previewDescription;

    showDetailsDialog();
  }

  function getModalData(point, coord) {
    console.log("point", point);
    console.log("coord", coord);
    point = point || [];
    coord = coord || [];
    var grids = gridAgent.value(),
      field = fieldAgent.value(),
      λ = coord[0],
      φ = coord[1];
    if (!field || !field.isInsideBoundary(point[0], point[1])) {
      return;
    }

    getData(φ, λ);
  }

  /**
   * Display a local data callout at the given [x, y] point and its corresponding [lon, lat] coordinates.
   * The location may not be valid, in which case no callout is displayed. Display location data for both
   * the primary grid and overlay grid, performing interpolation when necessary.
   */
  function showLocationDetails(point, coord) {
    point = point || [];
    coord = coord || [];
    var grids = gridAgent.value(),
      field = fieldAgent.value(),
      λ = coord[0],
      φ = coord[1];
    if (!field || !field.isInsideBoundary(point[0], point[1])) {
      return;
    }

    clearLocationDetails(false); // clean the slate
    activeLocation = { point: point, coord: coord }; // remember where the current location is

    if (_.isFinite(λ) && _.isFinite(φ)) {
      d3.select("#location-coord").text(µ.formatCoordinates(λ, φ));
      d3.select("#location-close").classed("invisible", false);
    }

    if (field.isDefined(point[0], point[1]) && grids) {
      var wind = grids.primaryGrid.interpolate(λ, φ);
      if (µ.isValue(wind)) {
        showWindAtLocation(wind, grids.primaryGrid);
      }
      if (grids.overlayGrid !== grids.primaryGrid) {
        var value = grids.overlayGrid.interpolate(λ, φ);
        if (µ.isValue(value)) {
          showOverlayValueAtLocation(value, grids.overlayGrid);
        }
      }
    }
  }

  //--------------------------------------------------------
  //Our own code

  function getData(latitude, longitude) {
    httpGetAsync("/api/basic?lat=" + latitude + "&lon=" + longitude, function(
      input
    ) {
      var content = JSON.parse(input);

      if (!content.hasOwnProperty("Error")) {
        // var country = content["Country"];
        // var items = content["Items"];

        populateModalContent(content);
      } else {
        console.log("An error has occured");
      }
    });
  }

  var timer;

  function randomizer() {
    // https://worldmap.harvard.edu/data/geonode:country_centroids_az8

    if(isRandomizing) {
      timer.stop();
    }

    isRandomizing = true;

    var randomIndex = getRandomInt(193);
    var vtLong = jsonRandom[randomIndex].Longitude;
    var vtLat = jsonRandom[randomIndex].Latitude;
    // var vtCountry = jsonRandom[randomIndex].country;

    const speed = 0.05;
    const threshold = 1;

    const desiredRotation = [vtLat, vtLong, 0];

    dispatch.trigger("moveStart");

    timer = d3.timer(() => {
      var currentRotation = globe.projection.rotate();

      var closeEnough =
        DistanceAngles(currentRotation[0], desiredRotation[0]) < threshold &&
        DistanceAngles(currentRotation[1], desiredRotation[1]) < threshold;

      //If close enough
      if (closeEnough) {
        console.log("Finished");
        timer.stop();

        setTimeout(() => {
          dispatch.trigger("moveEnd");
          isRandomizing = false; //Everything has finished
        }, 3000);
      }

      var nextRotation = [
        Lerp(currentRotation[0], desiredRotation[0], speed),
        Lerp(currentRotation[1], desiredRotation[1], speed),
        0
      ];

      globe.projection.rotate(nextRotation);

      dispatch.trigger("move");
    });
  }

  function getRandomInt(max) {
    return Math.floor(Math.random() * Math.floor(max));
  }

  function httpGetAsync(theUrl, callback) {
    var xmlHttp = new XMLHttpRequest();
    xmlHttp.onreadystatechange = function() {
      if (xmlHttp.readyState == 4 && xmlHttp.status == 200)
        callback(xmlHttp.responseText);
    };
    xmlHttp.open("GET", theUrl, true); // true for asynchronous
    xmlHttp.send(null);
  }
  //--------------------------------------------------------------

  function showDetailsDialog() {
    if (jQuery("#foreground path[d]").length > 0) {
      if (modalContent["title"] != "") {
        $("#region-modal-summary-modal .modal-title").text(
          modalContent["title"]
        );
        // console.log('title',modalContent['title']);
      }

      if (modalContent["body"] != "") {
        $("#region-modal-summary-modal .modal-body .modal-body-text").text(
          modalContent["body"]
        );
        // console.log('body',modalContent['body']);
      }

      if (modalContent["images"].length > 0) {
        var previewUrl = modalContent["images"][0];
        $(
          "#region-modal-summary-modal .modal-body .modal-body-preview-image"
        ).prop("src", previewUrl);
        // console.log('image', previewUrl);
      }

      // title: '',
      // body: '',
      // images: '',
      // video: ''

      $("#region-modal-summary-modal").modal("toggle");
    } else if (jQuery("#region-summary-modal").hasClass("open-dialog")) {
      $("#region-modal-summary-modal").modal("toggle");
    }
  }

  function updateLocationDetails() {
    showLocationDetails(activeLocation.point, activeLocation.coord);
  }

  function clearLocationDetails(clearEverything) {
    d3.select("#location-coord").text("");
    d3.select("#location-close").classed("invisible", true);
    d3.select("#location-wind").text("");
    d3.select("#location-wind-units").text("");
    d3.select("#location-value").text("");
    d3.select("#location-value-units").text("");
    if (clearEverything) {
      activeLocation = {};
      d3.select(".location-mark").remove();
    }
  }

  function stopCurrentAnimation(alsoClearCanvas) {
    animatorAgent.cancel();
    if (alsoClearCanvas) {
      µ.clearCanvas(d3.select("#animation").node());
    }
  }

  /**
   * Registers a click event handler for the specified DOM element which modifies the configuration to have
   * the attributes represented by newAttr. An event listener is also registered for configuration change events,
   * so when a change occurs the button becomes highlighted (i.e., class ".highlighted" is assigned or removed) if
   * the configuration matches the attributes for this button. The set of attributes used for the matching is taken
   * from newAttr, unless a custom set of keys is provided.
   */
  function bindButtonToConfiguration(elementId, newAttr, keys) {
    keys = keys || _.keys(newAttr);
    d3.select(elementId).on("click", function() {
      if (d3.select(elementId).classed("disabled")) return;
      configuration.save(newAttr);
    });
    configuration.on("change", function(model) {
      var attr = model.attributes;
      d3.select(elementId).classed(
        "highlighted",
        _.isEqual(_.pick(attr, keys), _.pick(newAttr, keys))
      );
    });
  }

  function reportSponsorClick(type) {
    if (ga) {
      ga("send", "event", "sponsor", type);
    }
  }

  /**
   * Registers all event handlers to bind components and page elements together. There must be a cleaner
   * way to accomplish this...
   */
  function init() {
    report.status("Initializing...");

    d3.select("#sponsor-link")
      .attr("target", µ.isEmbeddedInIFrame() ? "_new" : null)
      .on("click", reportSponsorClick.bind(null, "click"))
      .on("contextmenu", reportSponsorClick.bind(null, "right-click"));
    d3.select("#sponsor-hide").on("click", function() {
      d3.select("#sponsor").classed("invisible", true);
    });

    d3.selectAll(".fill-screen")
      .attr("width", view.width)
      .attr("height", view.height);
    // Adjust size of the scale canvas to fill the width of the menu to the right of the label.
    var label = d3.select("#scale-label").node();
    d3.select("#scale")
      .attr(
        "width",
        (d3.select("#menu").node().offsetWidth - label.offsetWidth) * 0.97
      )
      .attr("height", label.offsetHeight / 2);

    // d3.select("#show-menu").on("click", function() {
    //     if (µ.isEmbeddedInIFrame()) {
    //         window.open("http://earth.nullschool.net/" + window.location.hash, "_blank");
    //     }
    //     else {
    //         d3.select("#menu").classed("invisible", !d3.select("#menu").classed("invisible"));
    //     }
    // });

    if (µ.isFF()) {
      // Workaround FF performance issue of slow click behavior on map having thick coastlines.
      d3.select("#display").classed("firefox", true);
    }

    // Tweak document to distinguish CSS styling between touch and non-touch environments. Hacky hack.
    if ("ontouchstart" in document.documentElement) {
      d3.select(document).on("touchstart", function() {}); // this hack enables :active pseudoclass
    } else {
      d3.select(document.documentElement).classed("no-touch", true); // to filter styles problematic for touch
    }

    // Bind configuration to URL bar changes.
    d3.select(window).on("hashchange", function() {
      log.debug("hashchange");
      var dispatch = _.extend(
        {
          globe: function(_) {
            if (_) {
              globe = _;
              zoom.scaleExtent(globe.scaleExtent());
              reorient();
            }
            return _ ? this : globe;
          }
        },
        Backbone.Events
      );
      var globe = globeAgent.value();
      // console.log(globe);
      if (
        getUrlParameter("random") == "true" &&
        globe &&
        window.location.hash.indexOf("orthographic=") > 0
      ) {
        var latlonStringWithParam = window.location.hash
          .substr(1)
          .split("orthographic=")[1];
        // console.log("latlonStringWithParam", latlonStringWithParam);
        var latlonString = latlonStringWithParam.split("?")[0];
        // console.log("latlonString", latlonString);
        var latlonScaleObj = latlonString.split(",");
        var latRequested = latlonScaleObj[0];
        var lonRequested = latlonScaleObj[1];
        var coord = [latRequested, lonRequested];
        console.log("globe.projection(coord)", globe.projection(coord));
        // var coord = [pos.coords.longitude, pos.coords.latitude];
        // console.log("activeLocation.point, activeLocation.coord",activeLocation.point, activeLocation.coord);
        // dispatch.trigger("click", globe.projection(coord), coord);
        showLocationDetails(globe.projection(coord), coord);
        startRendering();
        getModalData(globe.projection(coord), coord);
        //
        // dispatch.trigger("click", activeLocation.point, activeLocation.coord);
        // $(document.elementFromPoint(x, y)).click();
        // configuration.changedAttributes();
        window.location.hash = window.location.hash.split("?")[0];
      }
      configuration.fetch({ trigger: "hashchange" });
    });

    configuration.on("change", report.reset);

    meshAgent.listenTo(configuration, "change:topology", function(
      context,
      attr
    ) {
      meshAgent.submit(buildMesh, attr);
    });

    globeAgent.listenTo(configuration, "change:projection", function(
      source,
      attr
    ) {
      globeAgent.submit(buildGlobe, attr);
    });

    gridAgent.listenTo(configuration, "change", function() {
      var changed = _.keys(configuration.changedAttributes()),
        rebuildRequired = false;

      // Build a new grid if any layer-related attributes have changed.
      if (
        _.intersection(changed, ["date", "hour", "param", "surface", "level"])
          .length > 0
      ) {
        rebuildRequired = true;
      }
      // Build a new grid if the new overlay type is different from the current one.
      var overlayType = configuration.get("overlayType") || "default";
      if (_.indexOf(changed, "overlayType") >= 0 && overlayType !== "off") {
        var grids = gridAgent.value() || {},
          primary = grids.primaryGrid,
          overlay = grids.overlayGrid;
        if (!overlay) {
          // Do a rebuild if we have no overlay grid.
          rebuildRequired = true;
        } else if (
          overlay.type !== overlayType &&
          !(overlayType === "default" && primary === overlay)
        ) {
          // Do a rebuild if the types are different.
          rebuildRequired = true;
        }
      }

      if (rebuildRequired) {
        gridAgent.submit(buildGrids);
      }
    });
    gridAgent.on("submit", function() {
      showGridDetails(null);
    });
    gridAgent.on("update", function(grids) {
      showGridDetails(grids);
    });
    d3.select("#toggle-zone").on("click", function() {
      d3.select("#data-date").classed(
        "local",
        !d3.select("#data-date").classed("local")
      );
      showDate(gridAgent.cancel.requested ? null : gridAgent.value());
    });

    function startRendering() {
      rendererAgent.submit(
        buildRenderer,
        meshAgent.value(),
        globeAgent.value()
      );
    }
    rendererAgent.listenTo(meshAgent, "update", startRendering);
    rendererAgent.listenTo(globeAgent, "update", startRendering);

    function startInterpolation() {
      fieldAgent.submit(
        interpolateField,
        globeAgent.value(),
        gridAgent.value()
      );
    }
    function cancelInterpolation() {
      fieldAgent.cancel();
    }
    fieldAgent.listenTo(gridAgent, "update", startInterpolation);
    fieldAgent.listenTo(rendererAgent, "render", startInterpolation);
    fieldAgent.listenTo(rendererAgent, "start", cancelInterpolation);
    fieldAgent.listenTo(rendererAgent, "redraw", cancelInterpolation);

    animatorAgent.listenTo(fieldAgent, "update", function(field) {
      animatorAgent.submit(
        animate,
        globeAgent.value(),
        field,
        gridAgent.value()
      );
    });
    animatorAgent.listenTo(
      rendererAgent,
      "start",
      stopCurrentAnimation.bind(null, true)
    );
    animatorAgent.listenTo(
      gridAgent,
      "submit",
      stopCurrentAnimation.bind(null, false)
    );
    animatorAgent.listenTo(
      fieldAgent,
      "submit",
      stopCurrentAnimation.bind(null, false)
    );

    overlayAgent.listenTo(fieldAgent, "update", function() {
      overlayAgent.submit(
        drawOverlay,
        fieldAgent.value(),
        configuration.get("overlayType")
      );
    });
    overlayAgent.listenTo(rendererAgent, "start", function() {
      overlayAgent.submit(drawOverlay, fieldAgent.value(), null);
    });
    overlayAgent.listenTo(configuration, "change", function() {
      var changed = _.keys(configuration.changedAttributes());
      // if only overlay relevant flags have changed...
      if (
        _.intersection(changed, ["overlayType", "showGridPoints"]).length > 0
      ) {
        overlayAgent.submit(
          drawOverlay,
          fieldAgent.value(),
          configuration.get("overlayType")
        );
      }
    });

    // Add event handlers for showing, updating, and removing location details.
    inputController.on("click", showLocationDetails);
    inputController.on("click", getModalData);

    $(".coolbox").on("click", function(e) {
      e.preventDefault();
      randomizer();
      // add your code here
    });

    fieldAgent.on("update", updateLocationDetails);
    d3.select("#location-close").on(
      "click",
      _.partial(clearLocationDetails, true)
    );

    // Modify menu depending on what mode we're in.
    configuration.on("change:param", function(context, mode) {
      d3.selectAll(".ocean-mode").classed("invisible", mode !== "ocean");
      d3.selectAll(".wind-mode").classed("invisible", mode !== "wind");
      switch (mode) {
        case "wind":
          d3.select("#nav-backward-more").attr("title", "-1 Day");
          d3.select("#nav-backward").attr("title", "-3 Hours");
          d3.select("#nav-forward").attr("title", "+3 Hours");
          d3.select("#nav-forward-more").attr("title", "+1 Day");
          break;
        case "ocean":
          d3.select("#nav-backward-more").attr("title", "-1 Month");
          d3.select("#nav-backward").attr("title", "-5 Days");
          d3.select("#nav-forward").attr("title", "+5 Days");
          d3.select("#nav-forward-more").attr("title", "+1 Month");
          break;
      }
    });

    // Add handlers for mode buttons.
    d3.select("#wind-mode-enable").on("click", function() {
      if (configuration.get("param") !== "wind") {
        configuration.save({
          param: "wind",
          surface: "surface",
          level: "level",
          overlayType: "default"
        });
      }
    });
    configuration.on("change:param", function(x, param) {
      d3.select("#wind-mode-enable").classed("highlighted", param === "wind");
    });
    d3.select("#ocean-mode-enable").on("click", function() {
      if (configuration.get("param") !== "ocean") {
        // When switching between modes, there may be no associated data for the current date. So we need
        // find the closest available according to the catalog. This is not necessary if date is "current".
        // UNDONE: this code is annoying. should be easier to get date for closest ocean product.
        var ocean = {
          param: "ocean",
          surface: "surface",
          level: "currents",
          overlayType: "default"
        };
        var attr = _.clone(configuration.attributes);
        if (attr.date === "current") {
          configuration.save(ocean);
        } else {
          when
            .all(products.productsFor(_.extend(attr, ocean)))
            .spread(function(product) {
              if (product.date) {
                configuration.save(
                  _.extend(ocean, µ.dateToConfig(product.date))
                );
              }
            })
            .otherwise(report.error);
        }
        stopCurrentAnimation(true); // cleanup particle artifacts over continents
      }
    });
    configuration.on("change:param", function(x, param) {
      d3.select("#ocean-mode-enable").classed("highlighted", param === "ocean");
    });

    // Add logic to disable buttons that are incompatible with each other.
    configuration.on("change:overlayType", function(x, ot) {
      d3.select("#surface-level").classed(
        "disabled",
        ot === "air_density" || ot === "wind_power_density"
      );
    });
    configuration.on("change:surface", function(x, s) {
      d3.select("#overlay-air_density").classed("disabled", s === "surface");
      d3.select("#overlay-wind_power_density").classed(
        "disabled",
        s === "surface"
      );
    });

    // Add event handlers for the time navigation buttons.
    d3.select("#nav-backward-more").on("click", navigate.bind(null, -10));
    d3.select("#nav-forward-more").on("click", navigate.bind(null, +10));
    d3.select("#nav-backward").on("click", navigate.bind(null, -1));
    d3.select("#nav-forward").on("click", navigate.bind(null, +1));
    d3.select("#nav-now").on("click", function() {
      configuration.save({ date: "current", hour: "" });
    });

    d3.select("#option-show-grid").on("click", function() {
      configuration.save({
        showGridPoints: !configuration.get("showGridPoints")
      });
    });
    configuration.on("change:showGridPoints", function(x, showGridPoints) {
      d3.select("#option-show-grid").classed("highlighted", showGridPoints);
    });

    // Add handlers for all wind level buttons.
    d3.selectAll(".surface").each(function() {
      var id = this.id,
        parts = id.split("-");
      bindButtonToConfiguration("#" + id, {
        param: "wind",
        surface: parts[0],
        level: parts[1]
      });
    });

    // Add handlers for ocean animation types.
    bindButtonToConfiguration("#animate-currents", {
      param: "ocean",
      surface: "surface",
      level: "currents"
    });

    // Add handlers for all overlay buttons.
    products.overlayTypes.forEach(function(type) {
      bindButtonToConfiguration("#overlay-" + type, { overlayType: type });
    });
    bindButtonToConfiguration("#overlay-wind", {
      param: "wind",
      overlayType: "default"
    });
    bindButtonToConfiguration("#overlay-ocean-off", { overlayType: "off" });
    bindButtonToConfiguration("#overlay-currents", { overlayType: "default" });

    // Add handlers for all projection buttons.
    globes.keys().forEach(function(p) {
      bindButtonToConfiguration("#" + p, { projection: p, orientation: "" }, [
        "projection"
      ]);
    });

    // When touch device changes between portrait and landscape, rebuild globe using the new view size.
    d3.select(window).on("orientationchange", function() {
      view = µ.view();
      globeAgent.submit(buildGlobe, configuration.get("projection"));
    });
  }

  function start() {
    // Everything is now set up, so load configuration from the hash fragment and kick off change events.
    configuration.fetch();
  }

  when(true)
    .then(init)
    .then(start)
    .otherwise(report.error);
})();

function getUrlParameter(sParam) {
  console.log("sParam", sParam);
  var sPageURL = decodeURIComponent(window.location.hash.substring(1)),
    sURLParams = sPageURL.split("?"),
    sParameterName,
    i;
  console.log("sPageURL", sPageURL);
  if (sURLParams.length < 2) {
    return null;
  }

  var sURLVariables = sURLParams[1];
  if (typeof sURLVariables === "string") {
    sURLVariables = [sURLVariables];
  }
  console.log("sURLVariables", sURLVariables);
  for (i = 0; i < sURLVariables.length; i++) {
    sParameterName = sURLVariables[i].split("=");
    console.log("sParameterName", sParameterName);

    if (sParameterName[0] === sParam) {
      console.log("sParameterName[0]", sParameterName[0]);
      return sParameterName[1] === undefined ? true : sParameterName[1];
    }
  }
  return null;
}

// Json central points
const jsonRandom = [
  {
    country: "Netherlands",
    Longitude: -69.98267711,
    Latitude: 12.52088038
  },
  {
    country: "Afghanistan",
    Longitude: 66.00473366,
    Latitude: 33.83523073
  },
  {
    country: "Angola",
    Longitude: 17.53736768,
    Latitude: -12.29336054
  },
  {
    country: "United Kingdom",
    Longitude: -63.06498927,
    Latitude: 18.2239595
  },
  {
    country: "Albania",
    Longitude: 20.04983396,
    Latitude: 41.14244989
  },
  {
    country: "Finland",
    Longitude: 19.95328768,
    Latitude: 60.21488688
  },
  {
    country: "Andorra",
    Longitude: 1.56054378,
    Latitude: 42.54229102
  },
  {
    country: "United Arab Emirates",
    Longitude: 54.3001671,
    Latitude: 23.90528188
  },
  {
    country: "Argentina",
    Longitude: -65.17980692,
    Latitude: -35.3813488
  },
  {
    country: "Armenia",
    Longitude: 44.92993276,
    Latitude: 40.28952569
  },
  {
    country: "United States of America",
    Longitude: -170.7180258,
    Latitude: -14.30445997
  },
  {
    country: "Antarctica",
    Longitude: 19.92108951,
    Latitude: -80.50857913
  },
  {
    country: "Australia",
    Longitude: 123.5838379,
    Latitude: -12.42993164
  },
  {
    country: "France",
    Longitude: 69.22666758,
    Latitude: -49.24895485
  },
  {
    country: "Antigua and Barbuda",
    Longitude: -61.79469343,
    Latitude: 17.2774996
  },
  {
    country: "Australia",
    Longitude: 134.4910001,
    Latitude: -25.73288704
  },
  {
    country: "Austria",
    Longitude: 14.1264761,
    Latitude: 47.58549439
  },
  {
    country: "Azerbaijan",
    Longitude: 47.54599879,
    Latitude: 40.28827235
  },
  {
    country: "Burundi",
    Longitude: 29.87512156,
    Latitude: -3.35939666
  },
  {
    country: "Belgium",
    Longitude: 4.64065114,
    Latitude: 50.63981576
  },
  {
    country: "Benin",
    Longitude: 2.32785254,
    Latitude: 9.6417597
  },
  {
    country: "Burkina Faso",
    Longitude: -1.75456601,
    Latitude: 12.26953846
  },
  {
    country: "Bangladesh",
    Longitude: 90.23812743,
    Latitude: 23.86731158
  },
  {
    country: "Bulgaria",
    Longitude: 25.21552909,
    Latitude: 42.76890318
  },
  {
    country: "Bahrain",
    Longitude: 50.54196932,
    Latitude: 26.04205135
  },
  {
    country: "Canada",
    Longitude: -98.30777028,
    Latitude: 61.36206324
  },
  {
    country: "The Bahamas",
    Longitude: -76.62843038,
    Latitude: 24.29036702
  },
  {
    country: "Bosnia and Herzegovina",
    Longitude: 17.76876733,
    Latitude: 44.17450125
  },
  {
    country: "France",
    Longitude: -62.84067779,
    Latitude: 17.89880451
  },
  {
    country: "Belarus",
    Longitude: 28.03209307,
    Latitude: 53.53131377
  },
  {
    country: "Belize",
    Longitude: -88.71010486,
    Latitude: 17.20027509
  },
  {
    country: "United Kingdom",
    Longitude: -64.7545589,
    Latitude: 32.31367802
  },
  {
    country: "Bolivia",
    Longitude: -64.68538645,
    Latitude: -16.70814787
  },
  {
    country: "Brazil",
    Longitude: -53.09783113,
    Latitude: -10.78777702
  },
  {
    country: "Barbados",
    Longitude: -59.559797,
    Latitude: 13.18145428
  },
  {
    country: "Brunei",
    Longitude: 114.7220304,
    Latitude: 4.51968958
  },
  {
    country: "Bhutan",
    Longitude: 90.40188155,
    Latitude: 27.41106589
  },
  {
    country: "Botswana",
    Longitude: 23.79853368,
    Latitude: -22.18403213
  },
  {
    country: "Central African Republic",
    Longitude: 20.46826831,
    Latitude: 6.56823297
  },
  {
    country: "Switzerland",
    Longitude: 8.20867471,
    Latitude: 46.79785878
  },
  {
    country: "Chile",
    Longitude: -71.38256213,
    Latitude: -37.73070989
  },
  {
    country: "China",
    Longitude: 103.8190735,
    Latitude: 36.56176546
  },
  {
    country: "Ivory Coast",
    Longitude: -5.5692157,
    Latitude: 7.6284262
  },
  {
    country: "Cameroon",
    Longitude: 12.73964156,
    Latitude: 5.69109849
  },
  {
    country: "Democratic Republic of the Congo",
    Longitude: 23.64396107,
    Latitude: -2.87746289
  },
  {
    country: "Republic of Congo",
    Longitude: 15.21965762,
    Latitude: -0.83787463
  },
  {
    country: "New Zealand",
    Longitude: -159.7872422,
    Latitude: -21.21927288
  },
  {
    country: "Colombia",
    Longitude: -73.08114582,
    Latitude: 3.91383431
  },
  {
    country: "Comoros",
    Longitude: 43.68253968,
    Latitude: -11.87783444
  },
  {
    country: "Cape Verde",
    Longitude: -23.9598882,
    Latitude: 15.95523324
  },
  {
    country: "Costa Rica",
    Longitude: -84.19208768,
    Latitude: 9.97634464
  },
  {
    country: "Cuba",
    Longitude: -79.01605384,
    Latitude: 21.62289528
  },
  {
    country: "Netherlands",
    Longitude: -68.97119369,
    Latitude: 12.19551675
  },
  {
    country: "United Kingdom",
    Longitude: -80.91213321,
    Latitude: 19.42896497
  },
  {
    country: "Northern Cyprus",
    Longitude: 33.5684813,
    Latitude: 35.26277486
  },
  {
    country: "Cyprus",
    Longitude: 33.0060022,
    Latitude: 34.91667211
  },
  {
    country: "Czech Republic",
    Longitude: 15.31240163,
    Latitude: 49.73341233
  },
  {
    country: "Germany",
    Longitude: 10.38578051,
    Latitude: 51.10698181
  },
  {
    country: "Djibouti",
    Longitude: 42.5606754,
    Latitude: 11.74871806
  },
  {
    country: "Dominica",
    Longitude: -61.357726,
    Latitude: 15.4394702
  },
  {
    country: "Denmark",
    Longitude: 10.02800992,
    Latitude: 55.98125296
  },
  {
    country: "Dominican Republic",
    Longitude: -70.50568896,
    Latitude: 18.89433082
  },
  {
    country: "Algeria",
    Longitude: 2.61732301,
    Latitude: 28.15893849
  },
  {
    country: "Ecuador",
    Longitude: -78.75201922,
    Latitude: -1.42381612
  },
  {
    country: "Egypt",
    Longitude: 29.86190099,
    Latitude: 26.49593311
  },
  {
    country: "Eritrea",
    Longitude: 38.84617011,
    Latitude: 15.36186618
  },
  {
    country: "Spain",
    Longitude: -3.64755047,
    Latitude: 40.24448698
  },
  {
    country: "Estonia",
    Longitude: 25.54248537,
    Latitude: 58.67192972
  },
  {
    country: "Ethiopia",
    Longitude: 39.60080098,
    Latitude: 8.62278679
  },
  {
    country: "Finland",
    Longitude: 26.2746656,
    Latitude: 64.49884603
  },
  {
    country: "Fiji",
    Longitude: 165.4519543,
    Latitude: -17.42858032
  },
  {
    country: "United Kingdom",
    Longitude: -59.35238956,
    Latitude: -51.74483954
  },
  {
    country: "France",
    Longitude: -2.76172945,
    Latitude: 42.17344011
  },
  {
    country: "Denmark",
    Longitude: -6.88095423,
    Latitude: 62.05385403
  },
  {
    country: "Federated States of Micronesia",
    Longitude: 153.2394379,
    Latitude: 7.45246814
  },
  {
    country: "Gabon",
    Longitude: 11.7886287,
    Latitude: -0.58660025
  },
  {
    country: "United Kingdom",
    Longitude: -2.86563164,
    Latitude: 54.12387156
  },
  {
    country: "Georgia",
    Longitude: 43.50780252,
    Latitude: 42.16855755
  },
  {
    country: "United Kingdom",
    Longitude: -2.57239064,
    Latitude: 49.46809761
  },
  {
    country: "Ghana",
    Longitude: -1.21676566,
    Latitude: 7.95345644
  },
  {
    country: "Guinea",
    Longitude: -10.94066612,
    Latitude: 10.43621593
  },
  {
    country: "Gambia",
    Longitude: -15.39601295,
    Latitude: 13.44965244
  },
  {
    country: "Guinea Bissau",
    Longitude: -14.94972445,
    Latitude: 12.04744948
  },
  {
    country: "Equatorial Guinea",
    Longitude: 10.34137924,
    Latitude: 1.70555135
  },
  {
    country: "Greece",
    Longitude: 22.95555794,
    Latitude: 39.07469623
  },
  {
    country: "Grenada",
    Longitude: -61.68220189,
    Latitude: 12.11725044
  },
  {
    country: "Denmark",
    Longitude: -41.34191127,
    Latitude: 74.71051289
  },
  {
    country: "Guatemala",
    Longitude: -90.36482009,
    Latitude: 15.69403664
  },
  {
    country: "United States of America",
    Longitude: 144.7679102,
    Latitude: 13.44165626
  },
  {
    country: "Guyana",
    Longitude: -58.98202459,
    Latitude: 4.79378034
  },
  {
    country: "China",
    Longitude: 114.1138045,
    Latitude: 22.39827737
  },
  {
    country: "Australia",
    Longitude: 73.5205171,
    Latitude: -53.08724656
  },
  {
    country: "Honduras",
    Longitude: -86.6151661,
    Latitude: 14.82688165
  },
  {
    country: "Croatia",
    Longitude: 16.40412899,
    Latitude: 45.08047631
  },
  {
    country: "Haiti",
    Longitude: -72.68527509,
    Latitude: 18.93502563
  },
  {
    country: "Hungary",
    Longitude: 19.39559116,
    Latitude: 47.16277506
  },
  {
    country: "Indonesia",
    Longitude: 117.2401137,
    Latitude: -2.21505456
  },
  {
    country: "United Kingdom",
    Longitude: -4.53873952,
    Latitude: 54.22418911
  },
  {
    country: "India",
    Longitude: 79.6119761,
    Latitude: 22.88578212
  },
  {
    country: "Australia",
    Longitude: 104.851898,
    Latitude: -10.6478515
  },
  {
    country: "United Kingdom",
    Longitude: 72.44541229,
    Latitude: -7.33059751
  },
  {
    country: "Ireland",
    Longitude: -8.13793569,
    Latitude: 53.1754487
  },
  {
    country: "Iran",
    Longitude: 54.27407004,
    Latitude: 32.57503292
  },
  {
    country: "Iraq",
    Longitude: 43.74353149,
    Latitude: 33.03970582
  },
  {
    country: "Iceland",
    Longitude: -18.57396167,
    Latitude: 64.99575386
  },
  {
    country: "Israel",
    Longitude: 35.00444693,
    Latitude: 31.46110101
  },
  {
    country: "Italy",
    Longitude: 12.07001339,
    Latitude: 42.79662641
  },
  {
    country: "Jamaica",
    Longitude: -77.31482593,
    Latitude: 18.15694878
  },
  {
    country: "United Kingdom",
    Longitude: -2.12689938,
    Latitude: 49.21837377
  },
  {
    country: "Jordan",
    Longitude: 36.77136104,
    Latitude: 31.24579091
  },
  {
    country: "Japan",
    Longitude: 138.0308956,
    Latitude: 37.59230135
  },
  {
    country: "Kashmir",
    Longitude: 77.18011865,
    Latitude: 35.39236325
  },
  {
    country: "Kazakhstan",
    Longitude: 67.29149357,
    Latitude: 48.15688067
  },
  {
    country: "Kenya",
    Longitude: 37.79593973,
    Latitude: 0.59988022
  },
  {
    country: "Kyrgyzstan",
    Longitude: 74.54165513,
    Latitude: 41.46221943
  },
  {
    country: "Cambodia",
    Longitude: 104.9069433,
    Latitude: 12.72004786
  },
  {
    country: "Kiribati",
    Longitude: -45.61110513,
    Latitude: 0.86001503
  },
  {
    country: "Saint Kitts and Nevis",
    Longitude: -62.68755265,
    Latitude: 17.2645995
  },
  {
    country: "South Korea",
    Longitude: 127.8391609,
    Latitude: 36.38523983
  },
  {
    country: "Kosovo",
    Longitude: 20.87249811,
    Latitude: 42.57078707
  },
  {
    country: "Kuwait",
    Longitude: 47.58700459,
    Latitude: 29.33431262
  },
  {
    country: "Laos",
    Longitude: 103.7377241,
    Latitude: 18.50217433
  },
  {
    country: "Lebanon",
    Longitude: 35.88016072,
    Latitude: 33.92306631
  },
  {
    country: "Liberia",
    Longitude: -9.32207573,
    Latitude: 6.45278492
  },
  {
    country: "Libya",
    Longitude: 18.00866169,
    Latitude: 27.03094495
  },
  {
    country: "Saint Lucia",
    Longitude: -60.96969923,
    Latitude: 13.89479481
  },
  {
    country: "Liechtenstein",
    Longitude: 9.53574312,
    Latitude: 47.13665835
  },
  {
    country: "Sri Lanka",
    Longitude: 80.70108238,
    Latitude: 7.61266509
  },
  {
    country: "Lesotho",
    Longitude: 28.22723131,
    Latitude: -29.58003188
  },
  {
    country: "Lithuania",
    Longitude: 23.88719355,
    Latitude: 55.32610984
  },
  {
    country: "Luxembourg",
    Longitude: 6.07182201,
    Latitude: 49.76725361
  },
  {
    country: "Latvia",
    Longitude: 24.91235983,
    Latitude: 56.85085163
  },
  {
    country: "China",
    Longitude: 113.5093212,
    Latitude: 22.22311688
  },
  {
    country: "France",
    Longitude: -63.05972851,
    Latitude: 18.08888611
  },
  {
    country: "Morocco",
    Longitude: -8.45615795,
    Latitude: 29.83762955
  },
  {
    country: "Monaco",
    Longitude: 7.40627677,
    Latitude: 43.75274627
  },
  {
    country: "Moldova",
    Longitude: 28.45673372,
    Latitude: 47.19498804
  },
  {
    country: "Madagascar",
    Longitude: 46.70473674,
    Latitude: -19.37189587
  },
  {
    country: "Maldives",
    Longitude: 73.45713004,
    Latitude: 3.7287092
  },
  {
    country: "Mexico",
    Longitude: -102.5234517,
    Latitude: 23.94753724
  },
  {
    country: "Marshall Islands",
    Longitude: 170.3397612,
    Latitude: 7.00376358
  },
  {
    country: "Macedonia",
    Longitude: 21.68211346,
    Latitude: 41.59530893
  },
  {
    country: "Mali",
    Longitude: -3.54269065,
    Latitude: 17.34581581
  },
  {
    country: "Malta",
    Longitude: 14.40523316,
    Latitude: 35.92149632
  },
  {
    country: "Myanmar",
    Longitude: 96.48843321,
    Latitude: 21.18566599
  },
  {
    country: "Montenegro",
    Longitude: 19.23883939,
    Latitude: 42.78890259
  },
  {
    country: "Mongolia",
    Longitude: 103.0529977,
    Latitude: 46.82681544
  },
  {
    country: "United States of America",
    Longitude: 145.6196965,
    Latitude: 15.82927563
  },
  {
    country: "Mozambique",
    Longitude: 35.53367543,
    Latitude: -17.27381643
  },
  {
    country: "Mauritania",
    Longitude: -10.34779815,
    Latitude: 20.25736706
  },
  {
    country: "United Kingdom",
    Longitude: -62.18518546,
    Latitude: 16.73941406
  },
  {
    country: "Mauritius",
    Longitude: 57.57120551,
    Latitude: -20.27768704
  },
  {
    country: "Malawi",
    Longitude: 34.28935599,
    Latitude: -13.21808088
  },
  {
    country: "Malaysia",
    Longitude: 109.6976228,
    Latitude: 3.78986846
  },
  {
    country: "Namibia",
    Longitude: 17.20963567,
    Latitude: -22.13032568
  },
  {
    country: "France",
    Longitude: 165.6849237,
    Latitude: -21.29991806
  },
  {
    country: "Niger",
    Longitude: 9.38545882,
    Latitude: 17.41912493
  },
  {
    country: "Australia",
    Longitude: 167.9492168,
    Latitude: -29.0514609
  },
  {
    country: "Nigeria",
    Longitude: 8.08943895,
    Latitude: 9.59411452
  },
  {
    country: "Nicaragua",
    Longitude: -85.0305297,
    Latitude: 12.84709429
  },
  {
    country: "New Zealand",
    Longitude: -169.8699468,
    Latitude: -19.04945708
  },
  {
    country: "Netherlands",
    Longitude: 5.28144793,
    Latitude: 52.1007899
  },
  {
    country: "Norway",
    Longitude: 15.34834656,
    Latitude: 68.75015572
  },
  {
    country: "Nepal",
    Longitude: 83.9158264,
    Latitude: 28.24891365
  },
  {
    country: "Nauru",
    Longitude: 166.9325682,
    Latitude: -0.51912639
  },
  {
    country: "New Zealand",
    Longitude: 171.4849235,
    Latitude: -41.81113557
  },
  {
    country: "Oman",
    Longitude: 56.09166155,
    Latitude: 20.60515333
  },
  {
    country: "Pakistan",
    Longitude: 69.33957937,
    Latitude: 29.9497515
  },
  {
    country: "Panama",
    Longitude: -80.11915156,
    Latitude: 8.51750797
  },
  {
    country: "United Kingdom",
    Longitude: -128.317042,
    Latitude: -24.36500535
  },
  {
    country: "Peru",
    Longitude: -74.38242685,
    Latitude: -9.15280381
  },
  {
    country: "Philippines",
    Longitude: 122.8839325,
    Latitude: 11.77536778
  },
  {
    country: "Palau",
    Longitude: 134.4080797,
    Latitude: 7.28742784
  },
  {
    country: "Papua New Guinea",
    Longitude: 145.2074475,
    Latitude: -6.46416646
  },
  {
    country: "Poland",
    Longitude: 19.39012835,
    Latitude: 52.12759564
  },
  {
    country: "United States of America",
    Longitude: -66.47307604,
    Latitude: 18.22813055
  },
  {
    country: "North Korea",
    Longitude: 127.1924797,
    Latitude: 40.15350311
  },
  {
    country: "Portugal",
    Longitude: -8.50104361,
    Latitude: 39.59550671
  },
  {
    country: "Paraguay",
    Longitude: -58.40013703,
    Latitude: -23.22823913
  },
  {
    country: "Israel",
    Longitude: 35.19628705,
    Latitude: 31.91613893
  },
  {
    country: "France",
    Longitude: -144.9049439,
    Latitude: -14.72227409
  },
  {
    country: "Qatar",
    Longitude: 51.18479632,
    Latitude: 25.30601188
  },
  {
    country: "Romania",
    Longitude: 24.97293039,
    Latitude: 45.85243127
  },
  {
    country: "Russia",
    Longitude: 96.68656112,
    Latitude: 61.98052209
  },
  {
    country: "Rwanda",
    Longitude: 29.91988515,
    Latitude: -1.99033832
  },
  {
    country: "Western Sahara",
    Longitude: -12.21982755,
    Latitude: 24.22956739
  },
  {
    country: "Saudi Arabia",
    Longitude: 44.53686271,
    Latitude: 24.12245841
  },
  {
    country: "Sudan",
    Longitude: 29.94046812,
    Latitude: 15.99035669
  },
  {
    country: "South Sudan",
    Longitude: 30.24790002,
    Latitude: 7.30877945
  },
  {
    country: "Senegal",
    Longitude: -14.4734924,
    Latitude: 14.36624173
  },
  {
    country: "Singapore",
    Longitude: 103.8172559,
    Latitude: 1.35876087
  },
  {
    country: "United Kingdom",
    Longitude: -36.43318388,
    Latitude: -54.46488248
  },
  {
    country: "United Kingdom",
    Longitude: -9.54779416,
    Latitude: -12.40355951
  },
  {
    country: "Solomon Islands",
    Longitude: 159.6328767,
    Latitude: -8.92178022
  },
  {
    country: "Sierra Leone",
    Longitude: -11.79271247,
    Latitude: 8.56329593
  },
  {
    country: "El Salvador",
    Longitude: -88.87164469,
    Latitude: 13.73943744
  },
  {
    country: "San Marino",
    Longitude: 12.45922334,
    Latitude: 43.94186747
  },
  {
    country: "Somaliland",
    Longitude: 46.25198395,
    Latitude: 9.73345496
  },
  {
    country: "Somalia",
    Longitude: 45.70714487,
    Latitude: 4.75062876
  },
  {
    country: "France",
    Longitude: -56.30319779,
    Latitude: 46.91918789
  },
  {
    country: "Republic of Serbia",
    Longitude: 20.78958334,
    Latitude: 44.2215032
  },
  {
    country: "Sao Tome and Principe",
    Longitude: 6.72429658,
    Latitude: 0.44391445
  },
  {
    country: "Suriname",
    Longitude: -55.9123457,
    Latitude: 4.13055413
  },
  {
    country: "Slovakia",
    Longitude: 19.47905218,
    Latitude: 48.70547528
  },
  {
    country: "Slovenia",
    Longitude: 14.80444238,
    Latitude: 46.11554772
  },
  {
    country: "Sweden",
    Longitude: 16.74558049,
    Latitude: 62.77966519
  },
  {
    country: "Swaziland",
    Longitude: 31.4819369,
    Latitude: -26.55843045
  },
  {
    country: "Netherlands",
    Longitude: -63.05713363,
    Latitude: 18.05081728
  },
  {
    country: "Seychelles",
    Longitude: 55.47603279,
    Latitude: -4.66099094
  },
  {
    country: "Syria",
    Longitude: 38.50788204,
    Latitude: 35.02547389
  },
  {
    country: "United Kingdom",
    Longitude: -71.97387881,
    Latitude: 21.83047572
  },
  {
    country: "Chad",
    Longitude: 18.64492513,
    Latitude: 15.33333758
  },
  {
    country: "Togo",
    Longitude: 0.96232845,
    Latitude: 8.52531356
  },
  {
    country: "Thailand",
    Longitude: 101.0028813,
    Latitude: 15.11815794
  },
  {
    country: "Tajikistan",
    Longitude: 71.01362631,
    Latitude: 38.5304539
  },
  {
    country: "Turkmenistan",
    Longitude: 59.37100021,
    Latitude: 39.11554137
  },
  {
    country: "East Timor",
    Longitude: 125.8443898,
    Latitude: -8.82889162
  },
  {
    country: "Tonga",
    Longitude: -174.8098734,
    Latitude: -20.42843174
  },
  {
    country: "Trinidad and Tobago",
    Longitude: -61.26567923,
    Latitude: 10.45733408
  },
  {
    country: "Tunisia",
    Longitude: 9.55288359,
    Latitude: 34.11956246
  },
  {
    country: "Turkey",
    Longitude: 35.16895346,
    Latitude: 39.0616029
  },
  {
    country: "Taiwan",
    Longitude: 120.9542728,
    Latitude: 23.7539928
  },
  {
    country: "United Republic of Tanzania",
    Longitude: 34.81309981,
    Latitude: -6.27565408
  },
  {
    country: "Uganda",
    Longitude: 32.36907971,
    Latitude: 1.27469299
  },
  {
    country: "Ukraine",
    Longitude: 31.38326469,
    Latitude: 48.99656673
  },
  {
    country: "Uruguay",
    Longitude: -56.01807053,
    Latitude: -32.79951534
  },
  {
    country: "United States of America",
    Longitude: -112.4616737,
    Latitude: 45.6795472
  },
  {
    country: "Uzbekistan",
    Longitude: 63.14001528,
    Latitude: 41.75554225
  },
  {
    country: "Vatican",
    Longitude: 12.43387177,
    Latitude: 41.90174985
  },
  {
    country: "Saint Vincent and the Grenadines",
    Longitude: -61.20129695,
    Latitude: 13.22472269
  },
  {
    country: "Venezuela",
    Longitude: -66.18184123,
    Latitude: 7.12422421
  },
  {
    country: "United Kingdom",
    Longitude: -64.47146992,
    Latitude: 18.52585755
  },
  {
    country: "United States of America",
    Longitude: -64.80301538,
    Latitude: 17.95500624
  },
  {
    country: "Vietnam",
    Longitude: 106.299147,
    Latitude: 16.6460167
  },
  {
    country: "Vanuatu",
    Longitude: 167.6864464,
    Latitude: -16.22640909
  },
  {
    country: "France",
    Longitude: -177.3483483,
    Latitude: -13.88737039
  },
  {
    country: "Samoa",
    Longitude: -172.1648506,
    Latitude: -13.75324346
  },
  {
    country: "Yemen",
    Longitude: 47.58676189,
    Latitude: 15.90928005
  },
  {
    country: "South Africa",
    Longitude: 25.08390093,
    Latitude: -29.00034095
  },
  {
    country: "Zambia",
    Longitude: 27.77475946,
    Latitude: -13.45824152
  },
  {
    country: "Zimbabwe",
    Longitude: 29.8514412,
    Latitude: -19.00420419
  }
];