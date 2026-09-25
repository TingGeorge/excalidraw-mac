#if os(macOS)
import Foundation

/// The app's own strings in English or Chinese, following the user's first system language.
enum L10n {
    static let isChinese = Locale.preferredLanguages.first?.hasPrefix("zh") ?? false

    static func t(_ english: String, _ chinese: String) -> String {
        isChinese ? chinese : english
    }
}
#endif
