import { Bot, X } from "lucide-react";

type WorldBotProps = {
  message: string;
  onClose: () => void;
};

export function WorldBot({ message, onClose }: WorldBotProps) {
  return (
    <div className="hidden md:block absolute right-4 bottom-4 z-30 max-w-xs">
      <div className="relative bg-white/95 backdrop-blur rounded-2xl border border-slate-200 shadow-lg p-3 pr-10">
        <button
          type="button"
          onClick={onClose}
          className="absolute top-2 right-2 text-slate-400 hover:text-slate-600 transition-colors"
          aria-label="Close bot"
        >
          <X className="w-4 h-4" />
        </button>

        <div className="flex items-start gap-3">
          <div className="shrink-0 w-9 h-9 rounded-full bg-blue-100 text-blue-700 flex items-center justify-center border border-blue-200">
            <Bot className="w-5 h-5" />
          </div>

          <div className="pt-0.5">
            <p className="text-xs font-semibold text-slate-700 mb-1">
              Island Bot
            </p>
            <p className="text-sm text-slate-600 leading-snug">{message}</p>
          </div>
        </div>
      </div>
    </div>
  );
}
