// AudioSpeedHelper.js
// Provides centralized audio speed control for MIDI buttons
// Similar to the recording example but focused on playback speed control
// Version 1.0.0
// Event: OnAwake

// @input Component.ScriptComponent bpmSliderScript

// Track the currently playing audio and its original sample rate
var currentAudioComponent = null;
var currentTrackProvider = null;
var originalSampleRate = null;
var currentSpeedFactor = 1.0;

// Initialize the helper
function initialize() {
    if (!script.bpmSliderScript) {
        print("Warning: No BPM slider script provided to AudioSpeedHelper");
        return;
    }
    
    // Connect to BPM slider events
    var sliderApi = script.bpmSliderScript;
    if (sliderApi && sliderApi.onValueUpdate) {
        sliderApi.onValueUpdate.add(onSliderValueChanged);
        print("AudioSpeedHelper: Connected to BPM slider");
    } else {
        print("Error: BPM slider script doesn't have expected API");
    }
}

// Handle slider value changes
function onSliderValueChanged(normalizedValue) {
    var sliderApi = script.bpmSliderScript;
    if (sliderApi && typeof sliderApi.getSpeedFactor === "function") {
        currentSpeedFactor = sliderApi.getSpeedFactor();
        
        // Apply speed to currently playing audio if any
        if (currentTrackProvider && originalSampleRate !== null) {
            try {
                currentTrackProvider.sampleRate = originalSampleRate * currentSpeedFactor;
                print("AudioSpeedHelper: Applied speed ×" + currentSpeedFactor.toFixed(2));
            } catch (error) {
                print("Error applying speed: " + error);
            }
        }
    }
}

// Register a new audio component as the active one
function registerAudio(audioComponent) {
    try {
        if (!audioComponent || !audioComponent.audioTrack) {
            print("Error: Invalid audio component provided");
            return false;
        }
        
        // Stop tracking previous audio
        if (currentAudioComponent && currentAudioComponent !== audioComponent) {
            print("AudioSpeedHelper: Switching to new audio source");
        }
        
        // Set up new audio tracking
        currentAudioComponent = audioComponent;
        currentTrackProvider = audioComponent.audioTrack.control;
        
        // Store original sample rate if not already stored for this track
        if (currentTrackProvider && originalSampleRate === null) {
            originalSampleRate = currentTrackProvider.sampleRate;
            print("AudioSpeedHelper: Stored original sample rate: " + originalSampleRate);
        }
        
        return true;
    } catch (error) {
        print("Error registering audio: " + error);
        return false;
    }
}

// Apply speed to a specific audio component
function applySpeedToAudio(audioComponent, speedFactor) {
    try {
        if (!audioComponent || !audioComponent.audioTrack) {
            print("Error: Invalid audio component");
            return false;
        }
        
        var trackProvider = audioComponent.audioTrack.control;
        if (!trackProvider) {
            print("Error: No track provider available");
            return false;
        }
        
        // If this is a new audio component, register it
        if (currentAudioComponent !== audioComponent) {
            registerAudio(audioComponent);
        }
        
        // Apply the speed factor
        if (originalSampleRate !== null) {
            trackProvider.sampleRate = originalSampleRate * speedFactor;
            currentSpeedFactor = speedFactor;
            print("AudioSpeedHelper: Applied speed ×" + speedFactor.toFixed(2) + " to audio");
            return true;
        } else {
            print("Error: Original sample rate not available");
            return false;
        }
    } catch (error) {
        print("Error applying speed to audio: " + error);
        return false;
    }
}

// Clear current audio tracking (called when audio stops)
function clearCurrentAudio() {
    currentAudioComponent = null;
    currentTrackProvider = null;
    originalSampleRate = null;
    currentSpeedFactor = 1.0;
    print("AudioSpeedHelper: Cleared current audio tracking");
}

// Get current speed factor
function getCurrentSpeedFactor() {
    return currentSpeedFactor;
}

// Check if an audio component is currently being tracked
function isTrackingAudio(audioComponent) {
    return currentAudioComponent === audioComponent;
}

// Public API
script.registerAudio = registerAudio;
script.applySpeedToAudio = applySpeedToAudio;
script.clearCurrentAudio = clearCurrentAudio;
script.getCurrentSpeedFactor = getCurrentSpeedFactor;
script.isTrackingAudio = isTrackingAudio;

// Initialize when script awakens
initialize();