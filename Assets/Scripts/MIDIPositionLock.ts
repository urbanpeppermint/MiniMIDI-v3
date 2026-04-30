import { Interactable } from 'SpectaclesInteractionKit/Components/Interaction/Interactable/Interactable';
import { InteractorEvent } from 'SpectaclesInteractionKit/Core/Interactor/InteractorEvent';
import { InteractableManipulation } from 'SpectaclesInteractionKit/Components/Interaction/InteractableManipulation/InteractableManipulation';
import { SIK } from 'SpectaclesInteractionKit/SIK';

/**
 * Position Lock Toggle System for InteractableManipulation
 * Locks/unlocks the manipulation of an assigned scene object
 * When locked, disables InteractableManipulation but preserves child interactions
 * CRITICAL: This script must be on an ENABLED object!
 */
@component export class PositionLockToggle extends BaseScriptComponent {
    // Toggle button (must have Interactable component)
    @input lockToggleButton: SceneObject;
    
    // Object to lock/unlock manipulation for (should have InteractableManipulation component)
    @input targetObject: SceneObject;
    
    // Optional visual feedback objects
    @input lockIndicator: SceneObject; // Shows when locked (e.g., lock icon)
    @input unlockIndicator: SceneObject; // Shows when unlocked (e.g., unlock icon)
    
    // Optional debug text
    @input debugText: Text;
    
    private isLocked: boolean = false;
    private isInitialized: boolean = false;
    
    // Store the InteractableManipulation component
    private targetManipulation: InteractableManipulation | null = null;
    private wasManipulationEnabled: boolean = true;
    
    // Store original transform values for enforcement
    private lockedPosition: vec3;
    private lockedRotation: quat;
    private lockedScale: vec3;

    onAwake(): void {
        print("PositionLockToggle: Awake");
        
        // Set initial state - unlocked by default
        this.setInitialState();
        
        // Create event for proper SIK initialization
        this.createEvent('OnStartEvent').bind(() => {
            this.onStartSetup();
        });
    }
    
    onStart(): void {
        print("PositionLockToggle: Start");
        // Let OnStartEvent handle the setup
    }
    
    private setInitialState(): void {
        // Start in unlocked state
        this.isLocked = false;
        
        // Find the InteractableManipulation component on target
        if (this.targetObject) {
            this.targetManipulation = this.targetObject.getComponent(InteractableManipulation.getTypeName()) as InteractableManipulation;
            if (this.targetManipulation) {
                this.wasManipulationEnabled = this.targetManipulation.enabled;
                print("Found InteractableManipulation component on target object");
            } else {
                print("WARNING: Target object has no InteractableManipulation component!");
            }
        }
        
        // Set visual indicators
        if (this.lockIndicator) this.lockIndicator.enabled = false;
        if (this.unlockIndicator) this.unlockIndicator.enabled = true;
        
        if (this.debugText) {
            this.debugText.text = "Position: Unlocked";
        }
        
        print("Initial state set: Position unlocked");
    }
    
    private onStartSetup(): void {
        print("PositionLockToggle: Running OnStartSetup");
        this.validateComponents();
        
        if (!this.checkRequiredComponents()) {
            print("PositionLockToggle: Missing critical components, initialization skipped");
            return;
        }
        
        this.setupButtonListener();
    }
    
    private validateComponents(): void {
        // Check required components
        if (!this.lockToggleButton) print("ERROR: Lock toggle button not set");
        if (!this.targetObject) print("ERROR: Target object not set");
        
        // Check for InteractableManipulation component
        if (this.targetObject && !this.targetManipulation) {
            print("ERROR: Target object has no InteractableManipulation component - position locking will not work properly");
        }
        
        // Check optional components
        if (!this.lockIndicator) print("INFO: No lock indicator set - visual feedback will be limited");
        if (!this.unlockIndicator) print("INFO: No unlock indicator set - visual feedback will be limited");
        
        // Check SIK
        if (!SIK.InteractionManager) {
            print("CRITICAL ERROR: SIK Interaction Manager not found!");
            return;
        }
        
        // Check interactable on toggle button
        if (this.lockToggleButton && !this.lockToggleButton.getComponent(Interactable.getTypeName())) {
            print("ERROR: Lock toggle button has no Interactable component!");
        }
    }
    
    private checkRequiredComponents(): boolean {
        return (
            SIK.InteractionManager != null &&
            this.lockToggleButton != null &&
            this.targetObject != null &&
            this.targetManipulation != null
        );
    }
    
    private setupButtonListener(): void {
        print("Setting up position lock toggle listener");
        
        if (this.lockToggleButton) {
            const toggleInteractable = this.lockToggleButton.getComponent(Interactable.getTypeName()) as Interactable;
            if (toggleInteractable) {
                toggleInteractable.onInteractorTriggerEnd.add(() => {
                    print("Position lock toggle pressed");
                    this.togglePositionLock();
                });
                print("Position lock toggle listener added");
            }
        }
        
        this.isInitialized = true;
        print("Position lock toggle system initialized!");
    }
    
    /**
     * Toggle the position lock state
     */
    private togglePositionLock(): void {
        this.isLocked = !this.isLocked;
        
        if (this.isLocked) {
            this.lockPosition();
        } else {
            this.unlockPosition();
        }
        
        this.updateVisualFeedback();
        
        print(`Position lock: ${this.isLocked ? 'LOCKED' : 'UNLOCKED'}`);
    }
    
    /**
     * Lock the target object's position by disabling manipulation
     */
    private lockPosition(): void {
        if (!this.targetObject || !this.targetManipulation) return;
        
        // Store current transform as the locked position
        const transform = this.targetObject.getTransform();
        this.lockedPosition = transform.getLocalPosition();
        this.lockedRotation = transform.getLocalRotation();
        this.lockedScale = transform.getLocalScale();
        
        // Disable InteractableManipulation component to prevent position changes
        // This stops manipulation while preserving child interactions
        this.wasManipulationEnabled = this.targetManipulation.enabled;
        this.targetManipulation.enabled = false;
        
        print("InteractableManipulation disabled - position locked, child interactions preserved");
    }
    
    /**
     * Unlock the target object's position by re-enabling manipulation
     */
    private unlockPosition(): void {
        if (!this.targetObject || !this.targetManipulation) return;
        
        // Re-enable InteractableManipulation component
        if (this.wasManipulationEnabled) {
            this.targetManipulation.enabled = true;
            print("InteractableManipulation re-enabled - position unlocked");
        }
    }
    
    /**
     * Update visual indicators based on lock state
     */
    private updateVisualFeedback(): void {
        // Update visual indicators
        if (this.lockIndicator) {
            this.lockIndicator.enabled = this.isLocked;
        }
        
        if (this.unlockIndicator) {
            this.unlockIndicator.enabled = !this.isLocked;
        }
        
        // Update debug text
        if (this.debugText) {
            this.debugText.text = this.isLocked ? "Position: LOCKED" : "Position: Unlocked";
        }
    }
    
    /**
     * Enforce locked position - reset if somehow moved while locked
     * This provides extra security in case position changes through other means
     */
    private enforcePositionLock(): void {
        if (!this.isLocked || !this.targetObject) return;
        
        const transform = this.targetObject.getTransform();
        const currentPos = transform.getLocalPosition();
        const currentRot = transform.getLocalRotation();
        const currentScale = transform.getLocalScale();
        
        // Check if position has changed (with tolerance for floating point errors)
        const positionChanged = 
            Math.abs(currentPos.x - this.lockedPosition.x) > 0.001 ||
            Math.abs(currentPos.y - this.lockedPosition.y) > 0.001 ||
            Math.abs(currentPos.z - this.lockedPosition.z) > 0.001;
            
        const rotationChanged = 
            Math.abs(currentRot.x - this.lockedRotation.x) > 0.001 ||
            Math.abs(currentRot.y - this.lockedRotation.y) > 0.001 ||
            Math.abs(currentRot.z - this.lockedRotation.z) > 0.001 ||
            Math.abs(currentRot.w - this.lockedRotation.w) > 0.001;
            
        const scaleChanged = 
            Math.abs(currentScale.x - this.lockedScale.x) > 0.001 ||
            Math.abs(currentScale.y - this.lockedScale.y) > 0.001 ||
            Math.abs(currentScale.z - this.lockedScale.z) > 0.001;
        
        // Reset to locked position if changed
        if (positionChanged || rotationChanged || scaleChanged) {
            transform.setLocalPosition(this.lockedPosition);
            transform.setLocalRotation(this.lockedRotation);
            transform.setLocalScale(this.lockedScale);
            print("Position enforced back to locked state");
        }
    }
    
    /**
     * Public methods for external scripts
     */
    public isPositionLocked(): boolean {
        return this.isLocked;
    }
    
    public forceUnlock(): void {
        if (this.isLocked) {
            this.isLocked = false;
            this.unlockPosition();
            this.updateVisualFeedback();
            print("Position force unlocked by external script");
        }
    }
    
    public forceLock(): void {
        if (!this.isLocked) {
            this.isLocked = true;
            this.lockPosition();
            this.updateVisualFeedback();
            print("Position force locked by external script");
        }
    }
    
    /**
     * Get reference to the manipulation component (for advanced usage)
     */
    public getManipulationComponent(): InteractableManipulation | null {
        return this.targetManipulation;
    }
    
    onUpdate(): void {
        // Enforce position lock if active (backup security)
        if (this.isLocked) {
            this.enforcePositionLock();
        }
        
        // Debug info if needed - uncomment for troubleshooting
        /*
        if (!this.isInitialized) {
            print("WARNING: Position Lock Toggle not properly initialized!");
        }
        */
    }
}