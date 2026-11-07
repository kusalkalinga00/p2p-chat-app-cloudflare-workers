import { Bot, X } from "lucide-react";

type WorldBotProps = {
  message: string;
  onClose: () => void;
};

export function WorldBot({ message, onClose }: WorldBotProps) {
  return (
    <div className="absolute right-4 bottom-4 z-30 hidden max-w-[286px] md:block">
      <div className="relative rounded-[18px] border-2 border-ink bg-cream px-3.5 py-3 pr-10 shadow-[4px_4px_0_var(--color-ink)]">
        <button
          type="button"
          onClick={onClose}
          className="absolute top-2 right-2 rounded-full p-0.5 text-ink/40 transition-colors hover:text-ink"
          aria-label="Close bot"
        >
          <X className="h-4 w-4" />
        </button>

        <div className="flex items-start gap-2.5">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border-2 border-ink bg-mustard">
            <Bot className="h-5 w-5" />
          </div>

          <div className="pt-0.5">
            <p className="mb-1 font-mono text-[9px] font-bold tracking-[0.16em] uppercase text-ink/60">
              island bot
            </p>
            <p className="text-[13px] leading-snug font-semibold">{message}</p>
          </div>
        </div>
      </div>
    </div>
  );
}
