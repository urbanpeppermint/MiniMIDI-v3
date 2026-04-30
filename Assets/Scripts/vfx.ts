import { Slider } from "SpectaclesInteractionKit/Components/UI/Slider/Slider";
/**
 * Helper script that controls scene objects based on slider value
 * Enables different scene objects when slider reaches minimum or maximum values
 */
@component
export class SliderSceneObjectController extends BaseScriptComponent {
    @input
    @hint("The Slider component to listen to")
    slider!: Slider

    @input
    @hint("Scene object to enable when slider reaches minimum value")
    minValueSceneObject!: SceneObject

    @input
    @hint("Scene object to enable when slider reaches maximum value") 
    maxValueSceneObject!: SceneObject

    @input
    @hint("Should the scene objects start disabled?")
    startDisabled: boolean = true

    private isAtMin: boolean = false
    private isAtMax: boolean = false

    onAwake(): void {
        // Validate required inputs
        if (!this.slider) {
            throw new Error("SliderSceneObjectController: Slider component is required")
        }
        if (!this.minValueSceneObject) {
            throw new Error("SliderSceneObjectController: Min value scene object is required")
        }
        if (!this.maxValueSceneObject) {
            throw new Error("SliderSceneObjectController: Max value scene object is required")
        }

        // Initialize scene objects state
        if (this.startDisabled) {
            this.minValueSceneObject.enabled = false
            this.maxValueSceneObject.enabled = false
        }

        // Wait for start event to ensure slider is fully initialized
        this.createEvent("OnStartEvent").bind(() => {
            this.setupSliderListeners()
            // Check initial state
            this.checkInitialSliderValue()
        })
    }

    private setupSliderListeners(): void {
        // Listen to value updates
        this.slider.onValueUpdate.add((value: number) => {
            this.handleValueChange(value)
        })

        // Listen to min/max value reached events
        this.slider.onMinValueReached.add((value: number) => {
            this.handleMinValueReached()
        })

        this.slider.onMaxValueReached.add((value: number) => {
            this.handleMaxValueReached()
        })
    }

    private checkInitialSliderValue(): void {
        const currentValue = this.slider.currentValue
        if (currentValue !== null) {
            this.handleValueChange(currentValue)
        }
    }

    private handleValueChange(value: number): void {
        const minValue = this.slider.minValue
        const maxValue = this.slider.maxValue

        // Check if we're at min or max values
        const isAtMin = Math.abs(value - minValue) < 0.001 // Small tolerance for floating point comparison
        const isAtMax = Math.abs(value - maxValue) < 0.001

        // Only update if state changed to avoid unnecessary operations
        if (isAtMin && !this.isAtMin) {
            this.handleMinValueReached()
        } else if (isAtMax && !this.isAtMax) {
            this.handleMaxValueReached()
        } else if (!isAtMin && !isAtMax && (this.isAtMin || this.isAtMax)) {
            // Neither min nor max - disable both
            this.disableBothObjects()
        }

        this.isAtMin = isAtMin
        this.isAtMax = isAtMax
    }

    private handleMinValueReached(): void {
        print("SliderSceneObjectController: Min value reached - enabling min scene object")
        this.minValueSceneObject.enabled = true
        this.maxValueSceneObject.enabled = false
        this.isAtMin = true
        this.isAtMax = false
    }

    private handleMaxValueReached(): void {
        print("SliderSceneObjectController: Max value reached - enabling max scene object")
        this.maxValueSceneObject.enabled = true
        this.minValueSceneObject.enabled = false
        this.isAtMax = true
        this.isAtMin = false
    }

    private disableBothObjects(): void {
        print("SliderSceneObjectController: Slider in middle range - disabling both scene objects")
        this.minValueSceneObject.enabled = false
        this.maxValueSceneObject.enabled = false
        this.isAtMin = false
        this.isAtMax = false
    }

    /**
     * Public method to manually enable/disable the min value scene object
     */
    public setMinObjectEnabled(enabled: boolean): void {
        if (enabled && this.maxValueSceneObject.enabled) {
            this.maxValueSceneObject.enabled = false
        }
        this.minValueSceneObject.enabled = enabled
    }

    /**
     * Public method to manually enable/disable the max value scene object  
     */
    public setMaxObjectEnabled(enabled: boolean): void {
        if (enabled && this.minValueSceneObject.enabled) {
            this.minValueSceneObject.enabled = false
        }
        this.maxValueSceneObject.enabled = enabled
    }

    /**
     * Get current state information
     */
    public getState(): {isAtMin: boolean, isAtMax: boolean, minObjectEnabled: boolean, maxObjectEnabled: boolean} {
        return {
            isAtMin: this.isAtMin,
            isAtMax: this.isAtMax,
            minObjectEnabled: this.minValueSceneObject.enabled,
            maxObjectEnabled: this.maxValueSceneObject.enabled
        }
    }
}