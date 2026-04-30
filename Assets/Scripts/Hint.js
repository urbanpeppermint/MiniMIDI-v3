// @input SceneObject hintObject
// @input string hintBody = "Pinch a genre, then Confirm stems, then pad buttons to play.\nDrag BPM (stem tempo) and Crossfade sliders.\nOptional: Theremin / spectrum ring when enabled."
// @input float displayDuration = 5.0
// @input float minScale = 1.0
// @input float maxScale = 1.5
// @input float pulseSpeed = 2.0

const TEXT_TYPE = "Text";

let elapsedTime = 0;
let isHintActive = true;

function applyHintText() {
    if (!script.hintObject) {
        return;
    }
    var textComp = script.hintObject.getComponent(TEXT_TYPE);
    if (textComp && script.hintBody && script.hintBody.length > 0) {
        textComp.text = script.hintBody;
    }
}

function onStart() {
    applyHintText();
    if (script.hintObject) {
        script.hintObject.enabled = true;
    }
}

var startEvent = script.createEvent("OnStartEvent");
startEvent.bind(onStart);

// Update function called every frame
function onUpdate(eventData) {
    if (!isHintActive || !script.hintObject) return;

    elapsedTime += eventData.getDeltaTime();

    var scaleFactor =
        script.minScale +
        (script.maxScale - script.minScale) * 0.5 * (1 + Math.sin(elapsedTime * script.pulseSpeed * Math.PI));
    script.hintObject.getTransform().setLocalScale(new vec3(scaleFactor, scaleFactor, scaleFactor));

    if (elapsedTime >= script.displayDuration) {
        script.hintObject.enabled = false;
        isHintActive = false;
    }
}

var updateEvent = script.createEvent("UpdateEvent");
updateEvent.bind(onUpdate);
