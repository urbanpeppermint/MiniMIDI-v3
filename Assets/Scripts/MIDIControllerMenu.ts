/**
 * MidiControllerMenu.ts
 * Handles genre button UI and switching between 5 genres
 * Properly releases layers when switching
 * Second round: stem toggles + Confirm (Lyria) + Back (genre list) — no generation until Confirm
 */

import { Interactable } from 'SpectaclesInteractionKit/Components/Interaction/Interactable/Interactable';
import { DJMidiManager } from './DJMidiManager';
import { AudioLayerManager } from './AudioLayerManager';
import { getGenreByMode, getGenreCount } from './GenreInstrumentData';

const STEM_COUNT = 9;
const TEXT_COMPONENT_TYPE = 'Text';

enum MidiMode {
    Mode1 = 1,
    Mode2 = 2,
    Mode3 = 3,
    Mode4 = 4,
    Mode5 = 5,
}

@component
export class MidiControllerMenu extends BaseScriptComponent {
    // ═══════════════════════════════════════════════════════════════
    // GENRE BUTTONS (5 total)
    // ═══════════════════════════════════════════════════════════════

    @input
    @hint('Genre 1 button (Electronic)')
    mode1Button: SceneObject;

    @input
    @hint('Genre 2 button (Hip Hop)')
    mode2Button: SceneObject;

    @input
    @hint('Genre 3 button (Lofi Jazz)')
    mode3Button: SceneObject;

    @input
    @hint('Genre 4 button (House)')
    mode4Button: SceneObject;

    @input
    @hint('Genre 5 button (Rock)')
    mode5Button: SceneObject;

    // ═══════════════════════════════════════════════════════════════
    // GENRE BUTTON LABELS (Text children)
    // ═══════════════════════════════════════════════════════════════

    @input
    @hint('Text label for Genre 1 button')
    @allowUndefined
    mode1Label: Text;

    @input
    @hint('Text label for Genre 2 button')
    @allowUndefined
    mode2Label: Text;

    @input
    @hint('Text label for Genre 3 button')
    @allowUndefined
    mode3Label: Text;

    @input
    @hint('Text label for Genre 4 button')
    @allowUndefined
    mode4Label: Text;

    @input
    @hint('Text label for Genre 5 button')
    @allowUndefined
    mode5Label: Text;

    // ═══════════════════════════════════════════════════════════════
    // PAD GRID (one holder, 9 tracks — same object as DJMidiManager.midiPadGrid)
    // ═══════════════════════════════════════════════════════════════

    @input
    @hint('Parent object whose children are the 9 pads (same reference as DJMidiManager.midiPadGrid)')
    midiPadGrid: SceneObject;

    // ═══════════════════════════════════════════════════════════════
    // STEM ROUND (Lyria) — same menu flow; shown after genre until Confirm or Back
    // ═══════════════════════════════════════════════════════════════

    @input
    @hint('Root object for stem toggles + Confirm + Back (e.g. LyriaStemPickPanel). Hidden until a genre needs stem selection.')
    @allowUndefined
    stemRoundRoot: SceneObject;

    @input
    @hint('Parent whose first 9 children are stem toggle buttons (same order as pads). Ignored if stemToggleButtons has 9 entries.')
    @allowUndefined
    stemToggleButtonsParent: SceneObject;

    @input
    @hint('Optional: exactly 9 toggle SceneObjects (pad order 0–8). Overrides parent children when length ≥ 9.')
    stemToggleButtons: SceneObject[] = [];

    @input
    @hint('Confirm — calls Lyria for selected stems only.')
    @allowUndefined
    stemConfirmButton: SceneObject;

    @input
    @hint('Back — return to genre buttons without generating.')
    @allowUndefined
    stemBackButton: SceneObject;

    // ═══════════════════════════════════════════════════════════════
    // MENU UI
    // ═══════════════════════════════════════════════════════════════

    @input
    @allowUndefined
    menuToggleButton: SceneObject;

    @input
    @allowUndefined
    menuContainer: SceneObject;

    @input
    @hint('Status/debug text')
    @allowUndefined
    debugText: Text;

    // ═══════════════════════════════════════════════════════════════
    // DJ MIDI MANAGER
    // ═══════════════════════════════════════════════════════════════

    @input
    @hint('DJMidiManager for Lyria generation')
    @allowUndefined
    djMidiManager: DJMidiManager;

    // ═══════════════════════════════════════════════════════════════
    // PRIVATE STATE
    // ═══════════════════════════════════════════════════════════════

    private currentMode: MidiMode = MidiMode.Mode1;
    private isMenuVisible: boolean = true;
    private isInitialized: boolean = false;
    private isSwitching: boolean = false;

    private readonly _stemMask: boolean[] = new Array(STEM_COUNT).fill(false);
    private readonly _stemBaseLabels: string[] = new Array(STEM_COUNT).fill('');
    private _pendingStemMode: number = 1;
    private _inStemRound: boolean = false;
    private _stemListenersHooked: boolean = false;

    // ═══════════════════════════════════════════════════════════════
    // LIFECYCLE
    // ═══════════════════════════════════════════════════════════════

    onAwake(): void {
        print('[MidiControllerMenu] Awake');
        this.createEvent('OnStartEvent').bind(() => {
            this.onStartSetup();
        });
    }

    private onStartSetup(): void {
        print('[MidiControllerMenu] Setting up...');

        this.setupGenreLabels();
        this.setInitialState();
        this.setupButtonListeners();
        this.setupStemListeners();

        this.isInitialized = true;
        print('[MidiControllerMenu] Initialized with 5 genres');
    }

    // ═══════════════════════════════════════════════════════════════
    // SETUP
    // ═══════════════════════════════════════════════════════════════

    private setupGenreLabels(): void {
        const labels = [this.mode1Label, this.mode2Label, this.mode3Label, this.mode4Label, this.mode5Label];

        for (let i = 0; i < labels.length; i++) {
            const label = labels[i];
            const genre = getGenreByMode(i + 1);

            if (label && genre) {
                label.text = `${genre.emoji} ${genre.name}`;
                print(`[MidiControllerMenu] Label ${i + 1}: ${genre.emoji} ${genre.name}`);
            }
        }
    }

    private setInitialState(): void {
        this.ensurePadGridEnabled();

        if (this.menuContainer) this.menuContainer.enabled = true;
        if (this.menuToggleButton) this.menuToggleButton.enabled = true;

        this.updateDebugText(1);
        this.showGenreRoundUi();
    }

    private ensurePadGridEnabled(): void {
        if (this.midiPadGrid) {
            this.midiPadGrid.enabled = true;
        }
    }

    private setupButtonListeners(): void {
        this.setupModeButton(this.mode1Button, MidiMode.Mode1);
        this.setupModeButton(this.mode2Button, MidiMode.Mode2);
        this.setupModeButton(this.mode3Button, MidiMode.Mode3);
        this.setupModeButton(this.mode4Button, MidiMode.Mode4);
        this.setupModeButton(this.mode5Button, MidiMode.Mode5);

        if (this.menuToggleButton) {
            const interactable = this.menuToggleButton.getComponent(Interactable.getTypeName()) as Interactable;
            if (interactable) {
                interactable.onInteractorTriggerEnd.add(() => {
                    this.toggleMenuVisibility();
                });
            }
        }

        print('[MidiControllerMenu] All button listeners setup');
    }

    private setupStemListeners(): void {
        if (this._stemListenersHooked) {
            return;
        }
        this._stemListenersHooked = true;

        const toggles = this.resolveStemToggleObjects();
        for (let i = 0; i < toggles.length && i < STEM_COUNT; i++) {
            const idx = i;
            const so = toggles[i];
            const it = so.getComponent(Interactable.getTypeName()) as Interactable | null;
            if (it) {
                it.onInteractorTriggerEnd.add(() => this.onStemTogglePressed(idx));
            }
        }

        this.hookStemActionButton(this.stemConfirmButton, () => this.onStemConfirmPressed());
        this.hookStemActionButton(this.stemBackButton, () => this.onStemBackPressed());
    }

    private hookStemActionButton(so: SceneObject | undefined, fn: () => void): void {
        if (!so) {
            return;
        }
        const it = so.getComponent(Interactable.getTypeName()) as Interactable | null;
        if (it) {
            it.onInteractorTriggerEnd.add(fn);
        }
    }

    private setupModeButton(button: SceneObject, mode: MidiMode): void {
        if (!button) return;

        const interactable = button.getComponent(Interactable.getTypeName()) as Interactable;
        if (interactable) {
            interactable.onInteractorTriggerEnd.add(() => {
                this.onModeButtonPressed(mode);
            });
            print(`[MidiControllerMenu] Mode ${mode} button listener added`);
        }
    }

    // ═══════════════════════════════════════════════════════════════
    // STEM ROUND
    // ═══════════════════════════════════════════════════════════════

    private canShowStemRound(): boolean {
        return !!(this.stemRoundRoot && this.stemConfirmButton && this.resolveStemToggleObjects().length >= STEM_COUNT);
    }

    private resolveStemToggleObjects(): SceneObject[] {
        if (this.stemToggleButtons && this.stemToggleButtons.length >= STEM_COUNT) {
            return this.stemToggleButtons.slice(0, STEM_COUNT);
        }
        const out: SceneObject[] = [];
        if (this.stemToggleButtonsParent) {
            const n = Math.min(STEM_COUNT, this.stemToggleButtonsParent.getChildrenCount());
            for (let i = 0; i < n; i++) {
                const c = this.stemToggleButtonsParent.getChild(i);
                if (c) {
                    out.push(c);
                }
            }
        }
        return out;
    }

    private setGenreButtonsEnabled(on: boolean): void {
        const buttons = [this.mode1Button, this.mode2Button, this.mode3Button, this.mode4Button, this.mode5Button];
        for (const b of buttons) {
            if (b) {
                b.enabled = on;
            }
        }
    }

    private showGenreRoundUi(): void {
        this._inStemRound = false;
        this.setGenreButtonsEnabled(true);
        if (this.stemRoundRoot) {
            this.stemRoundRoot.enabled = false;
        }
    }

    private showStemRoundForMode(mode: number): void {
        if (!this.canShowStemRound()) {
            print('[MidiControllerMenu] Stem round UI incomplete — assign stemRoundRoot, stemConfirmButton, and 9 stem toggles.');
            this.showGenreRoundUi();
            return;
        }

        this._pendingStemMode = Math.max(1, Math.min(getGenreCount(), Math.floor(mode)));
        this._inStemRound = true;

        const genre = getGenreByMode(this._pendingStemMode);
        const toggles = this.resolveStemToggleObjects();

        for (let i = 0; i < STEM_COUNT; i++) {
            this._stemMask[i] = false;
            if (genre && i < genre.instruments.length) {
                const inst = genre.instruments[i];
                this._stemBaseLabels[i] = `${inst.emoji} ${inst.name}`.trim();
            } else {
                this._stemBaseLabels[i] = `Pad ${i + 1}`;
            }
            if (i < toggles.length) {
                this.applyStemToggleLabel(toggles[i], i);
            }
        }

        this.setGenreButtonsEnabled(false);
        if (this.stemRoundRoot) {
            this.stemRoundRoot.enabled = true;
        }
    }

    private onStemTogglePressed(index: number): void {
        if (!this._inStemRound || index < 0 || index >= STEM_COUNT) {
            return;
        }
        this._stemMask[index] = !this._stemMask[index];
        const toggles = this.resolveStemToggleObjects();
        if (index < toggles.length) {
            this.applyStemToggleLabel(toggles[index], index);
        }
    }

    private applyStemToggleLabel(buttonSo: SceneObject, index: number): void {
        const t = this.findTextOnOrUnder(buttonSo);
        if (!t) {
            return;
        }
        const base = this._stemBaseLabels[index] || `Pad ${index + 1}`;
        t.text = this._stemMask[index] ? `${base}  ✓` : `${base}  ·`;
    }

    private findTextOnOrUnder(so: SceneObject): Text | null {
        const direct = so.getComponent(TEXT_COMPONENT_TYPE) as Text | null;
        if (direct) {
            return direct;
        }
        const n = so.getChildrenCount();
        for (let i = 0; i < n; i++) {
            const ch = so.getChild(i);
            if (!ch) {
                continue;
            }
            const tt = ch.getComponent(TEXT_COMPONENT_TYPE) as Text | null;
            if (tt) {
                return tt;
            }
        }
        return null;
    }

    private onStemConfirmPressed(): void {
        if (!this._inStemRound || !this.djMidiManager) {
            return;
        }
        let any = false;
        for (let i = 0; i < STEM_COUNT; i++) {
            if (this._stemMask[i]) {
                any = true;
                break;
            }
        }
        if (!any) {
            print('[MidiControllerMenu] Select at least one stem before confirming.');
            return;
        }
        const mask = this._stemMask.slice(0, STEM_COUNT);
        this.djMidiManager.startLyriaGenerationWithStemMask(this._pendingStemMode, mask);
        this.showGenreRoundUi();
    }

    private onStemBackPressed(): void {
        if (!this._inStemRound) {
            return;
        }
        const mode = this._pendingStemMode;
        this.showGenreRoundUi();
        if (this.djMidiManager) {
            this.djMidiManager.onStemPickCancelled(mode);
        }
    }

    private afterGenreSelectedFromDj(mode: number): void {
        if (!this.djMidiManager) {
            this.showGenreRoundUi();
            return;
        }
        if (this.djMidiManager.isGenreGenerated(mode)) {
            this.showGenreRoundUi();
            return;
        }
        if (this.canShowStemRound()) {
            this.showStemRoundForMode(mode);
        } else {
            this.showGenreRoundUi();
            print(
                '[MidiControllerMenu] Genre has no clips yet — wire stemRoundRoot, stemToggleButtonsParent (or 9 stemToggleButtons), and stemConfirmButton to choose stems.'
            );
        }
    }

    // ═══════════════════════════════════════════════════════════════
    // MODE SWITCHING
    // ═══════════════════════════════════════════════════════════════

    private onModeButtonPressed(mode: MidiMode): void {
        if (this.isSwitching) {
            print(`[MidiControllerMenu] Already switching, ignoring`);
            return;
        }

        if (this.currentMode === mode) {
            if (this.djMidiManager) {
                const pads = this.djMidiManager.getPadsForCurrentMode();
                const hasAnyAudio = pads.some((pad) => pad.hasAudio());

                if (!hasAnyAudio) {
                    print(`[MidiControllerMenu] Mode ${mode} selected but no audio generated, opening stem / genre flow...`);
                    this.isSwitching = true;
                    this.djMidiManager.onGenreSelected(mode);
                    this.afterGenreSelectedFromDj(mode);
                    const ev = this.createEvent('DelayedCallbackEvent') as DelayedCallbackEvent;
                    ev.bind(() => {
                        this.isSwitching = false;
                    });
                    ev.reset(0.5);
                    return;
                }
            }

            print(`[MidiControllerMenu] Already on mode ${mode} with audio generated`);
            return;
        }

        this.isSwitching = true;
        print(`[MidiControllerMenu] ═══════════════════════════════════════`);
        print(`[MidiControllerMenu] Switching from mode ${this.currentMode} to mode ${mode}`);

        const manager = AudioLayerManager.getInstance();
        if (manager) {
            print(`[MidiControllerMenu] Before release: ${manager.getActiveLayerCount()} layers in use`);
            manager.releaseAllLayers();
            print(`[MidiControllerMenu] After release: ${manager.getActiveLayerCount()} layers in use`);
        }

        this.switchToMode(mode);

        if (this.djMidiManager) {
            this.djMidiManager.onGenreSelected(mode);
            this.afterGenreSelectedFromDj(mode);
        } else {
            this.showGenreRoundUi();
        }

        const ev = this.createEvent('DelayedCallbackEvent') as DelayedCallbackEvent;
        ev.bind(() => {
            this.isSwitching = false;
        });
        ev.reset(0.5);
    }

    private switchToMode(mode: MidiMode): void {
        print(`[MidiControllerMenu] Switching UI to Mode ${mode}`);
        this.currentMode = mode;

        this.ensurePadGridEnabled();

        this.updateDebugText(mode);
    }

    // ═══════════════════════════════════════════════════════════════
    // UI HELPERS
    // ═══════════════════════════════════════════════════════════════

    private updateDebugText(mode: number): void {
        const genre = getGenreByMode(mode);
        if (this.debugText && genre) {
            this.debugText.text = `${genre.emoji} ${genre.name} @ ${genre.bpm} BPM`;
        }
    }

    private toggleMenuVisibility(): void {
        this.isMenuVisible = !this.isMenuVisible;
        if (this.menuContainer) this.menuContainer.enabled = this.isMenuVisible;
        if (this.menuToggleButton) this.menuToggleButton.enabled = true;
        print(`[MidiControllerMenu] Menu ${this.isMenuVisible ? 'shown' : 'hidden'}`);
    }

    // ═══════════════════════════════════════════════════════════════
    // PUBLIC API
    // ═══════════════════════════════════════════════════════════════

    public getCurrentMode(): MidiMode {
        return this.currentMode;
    }

    public isReady(): boolean {
        return this.isInitialized;
    }
}
