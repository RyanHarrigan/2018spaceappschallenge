function Clamp01(value) {
    if (value < 0)
        return 0;
    else if (value > 1)
        return 1;
    else
        return value;
}

function Lerp(a, b, t) {
    return a + (b - a) * Clamp01(t);
}

function DistanceAngles(alpha, beta) {
    var phi = Math.abs(beta - alpha) % 360; // This is either the distance or 360 - distance
    var distance = phi > 180 ? 360 - phi : phi;
    return distance;
}