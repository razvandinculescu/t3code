// Load before app imports: shared project schemas construct Intl.Segmenter,
// which Hermes does not provide. Native implementations are left intact.
import "unicode-segmenter/intl-polyfill";
