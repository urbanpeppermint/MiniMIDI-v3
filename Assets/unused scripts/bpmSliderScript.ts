import NativeLogger from "SpectaclesInteractionKit/Utils/NativeLogger";

const log = new NativeLogger("BPMSliderController");

@component
export class BPMSliderController extends BaseScriptComponent {
  @input @hint("Drag the SIK Slider's ScriptComponent here")
  public sliderScript: ScriptComponent;

  @input @hint("Min speed (0.5 = half-speed)")
  public minSpeed: number = 0.5;

  @input @hint("Max speed (2.0 = double-speed)")
  public maxSpeed: number = 2.0;

  private speedFactor: number = 1.0;

  // Called by other scripts to read current factor
  public getSpeedFactor(): number {
    return this.speedFactor;  // value between minSpeed…maxSpeed
  }

  onStart() {
    if (!this.sliderScript) {
      log.e("sliderScript not set");
      return;
    }
    const api = (this.sliderScript as any).api;
    // **Corrected check**: onValueUpdate is a PublicApi<number>, not a function :contentReference[oaicite:0]{index=0}
    if (!api || !api.onValueUpdate || typeof api.onValueUpdate.add !== "function") {
      log.e("sliderScript.api.onValueUpdate missing or not a PublicApi");
      return;
    }

    // Init at midpoint
    api.currentValue = 0.5;
    this.updateFactor(0.5);

    // Listen for knob moves
    api.onValueUpdate.add((norm: number) => {
      this.updateFactor(norm);
      log.d(`BPMSliderController: speedFactor=${this.speedFactor}`);
    });

    log.d(`BPMSliderController initialized at speedFactor=${this.speedFactor}`);
  }

  private updateFactor(norm: number) {
    this.speedFactor = this.minSpeed + norm * (this.maxSpeed - this.minSpeed);
  }
}
