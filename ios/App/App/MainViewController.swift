import Capacitor
import UIKit

/** The app's one screen: Capacitor's web view, with the app's own native plugin registered. */
class MainViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(HermitNativePlugin())
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        // Until the page has drawn, show the editor's background, light or dark, as the launch screen does.
        let background = UIColor(named: "LaunchBackground")
        view.backgroundColor = background
        webView?.isOpaque = false
        webView?.backgroundColor = background
        webView?.scrollView.backgroundColor = background
        // No rubber-banding of the whole page; the panes scroll on their own.
        webView?.scrollView.bounces = false
        webView?.scrollView.contentInsetAdjustmentBehavior = .never
    }
}
