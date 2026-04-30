export class ServiceLocator {
    private static _instance: ServiceLocator | null = null;
    private map: Map<string, unknown> = new Map();

    public static get instance(): ServiceLocator {
        if (!ServiceLocator._instance) {
            ServiceLocator._instance = new ServiceLocator();
        }
        return ServiceLocator._instance;
    }

    public register<T>(key: string, value: T): void {
        this.map.set(key, value as unknown);
    }

    public get<T>(key: string): T | null {
        const v = this.map.get(key);
        return (v as T) ?? null;
    }
}

export const SERVICE_KEYS = {
    audio: "service.audio",
    gesture: "service.gesture",
    sequencer: "service.sequencer",
    ui: "service.ui",
    perf: "service.perf",
    leadSurface: "service.leadSurface",
    scaleBarLead: "service.scaleBarLead",
} as const;
