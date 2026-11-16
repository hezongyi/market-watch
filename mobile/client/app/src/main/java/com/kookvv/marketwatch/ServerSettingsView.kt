package com.kookvv.marketwatch

import android.content.Context
import android.content.res.ColorStateList
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.RippleDrawable
import android.text.InputType
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputMethodManager
import android.widget.Button
import android.widget.EditText
import android.widget.ImageButton
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import androidx.core.view.ViewCompat
import androidx.core.widget.doAfterTextChanged

/** Local connection setup must remain usable when the server cannot be reached. */
internal class ServerSettingsView(
    context: Context,
    private val light: Boolean,
    savedOrigin: String?,
    private val parseOrigin: (String) -> String?,
    private val onConnect: (String) -> Unit,
    private val onBack: () -> Unit,
) : ScrollView(context) {
    private fun color(value: String) = Color.parseColor(value)
    private fun dp(value: Int) = (value * resources.displayMetrics.density + 0.5f).toInt()
    private val ink = color(if (light) "#172132" else "#edf1f8")
    private val muted = color(if (light) "#536075" else "#a1adbf")
    private val surface = color(if (light) "#ffffff" else "#181d24")
    private val line = color(if (light) "#d9dfeb" else "#2c3440")
    private val accent = color(if (light) "#285dcc" else "#3669d8")
    private val danger = color(if (light) "#b42338" else "#ff8f9b")
    private var invalid = false
    private var submitting = false

    private fun rounded(fill: Int, stroke: Int = Color.TRANSPARENT, radius: Int = 12) =
        GradientDrawable().apply {
            setColor(fill)
            cornerRadius = dp(radius).toFloat()
            setStroke(dp(1), stroke)
        }

    private fun ripple(fill: Int, radius: Int = 12) = RippleDrawable(
        ColorStateList.valueOf(color(if (light) "#18285dcc" else "#30ffffff")),
        rounded(fill, radius = radius), rounded(Color.WHITE, radius = radius),
    )

    private fun label(value: Int, size: Float, tone: Int = ink, bold: Boolean = false) =
        TextView(context).apply {
            text = context.getString(value)
            textSize = size
            setTextColor(tone)
            if (bold) typeface = Typeface.create("sans-serif-medium", Typeface.NORMAL)
            setLineSpacing(dp(3).toFloat(), 1f)
        }

    private fun LinearLayout.space(height: Int) = addView(View(context), LinearLayout.LayoutParams(1, dp(height)))
    private fun LinearLayout.full(view: View) = addView(view, LinearLayout.LayoutParams(
        ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT,
    ))

    init {
        isFillViewport = true
        clipToPadding = false
        isVerticalScrollBarEnabled = false
        // Opening settings should not summon the keyboard before the user chooses to edit.
        isFocusableInTouchMode = true
        val column = object : LinearLayout(context) {
            override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
                val width = minOf(MeasureSpec.getSize(widthMeasureSpec), dp(460))
                super.onMeasure(MeasureSpec.makeMeasureSpec(width, MeasureSpec.EXACTLY), heightMeasureSpec)
            }
        }.apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(24), dp(8), dp(24), dp(28))
            isFocusableInTouchMode = true
        }
        addView(column, android.widget.FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.TOP or Gravity.CENTER_HORIZONTAL,
        ))

        val toolbar = LinearLayout(context).apply { gravity = Gravity.CENTER_VERTICAL }
        if (savedOrigin != null) {
            val back = ImageButton(context).apply {
                contentDescription = context.getString(R.string.server_back)
                setImageResource(R.drawable.ic_server_back)
                imageTintList = ColorStateList.valueOf(ink)
                background = ripple(Color.TRANSPARENT)
                setPadding(dp(11), dp(11), dp(11), dp(11))
                setOnClickListener { goBack() }
            }
            toolbar.addView(back, LinearLayout.LayoutParams(dp(44), dp(44)).apply { marginStart = -dp(10) })
        }
        toolbar.addView(label(R.string.server_settings, 14f, muted), LinearLayout.LayoutParams(
            0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f,
        ))
        toolbar.minimumHeight = dp(44)
        column.full(toolbar)
        column.space(36)
        val brand = ImageView(context).apply {
            setImageResource(R.drawable.ic_launcher_foreground)
            background = rounded(Color.WHITE, color("#e4e8ef"), 17)
            importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO
        }
        column.addView(brand, LinearLayout.LayoutParams(dp(60), dp(60)))
        column.space(24)
        column.full(label(if (savedOrigin == null) R.string.server_welcome else R.string.server_change, 27f, bold = true).apply {
            ViewCompat.setAccessibilityHeading(this, true)
        })
        column.space(8)
        column.full(label(R.string.server_description, 14f, muted))
        column.space(32)

        val addressId = View.generateViewId()
        column.full(label(R.string.server_address, 13f, bold = true).apply { labelFor = addressId })
        column.space(10)
        val input = LinearLayout(context).apply {
            gravity = Gravity.CENTER_VERTICAL
            minimumHeight = dp(54)
            background = rounded(surface, line)
        }
        val address = EditText(context).apply {
            id = addressId
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI
            imeOptions = EditorInfo.IME_ACTION_GO or EditorInfo.IME_FLAG_NO_EXTRACT_UI
            setSingleLine(true)
            textDirection = TEXT_DIRECTION_LTR
            textSize = 16f
            setTextColor(ink)
            setHintTextColor(muted)
            hint = context.getString(R.string.server_address_hint)
            setText(savedOrigin ?: "")
            setSelection(text.length)
            background = null
            minimumHeight = dp(54)
            setPadding(dp(14), dp(12), 0, dp(12))
            importantForAutofill = IMPORTANT_FOR_AUTOFILL_NO
        }
        input.addView(address, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        val clear = ImageButton(context).apply {
            contentDescription = context.getString(R.string.server_clear)
            setImageResource(R.drawable.ic_server_clear)
            imageTintList = ColorStateList.valueOf(muted)
            background = ripple(Color.TRANSPARENT, 9)
            setPadding(dp(13), dp(13), dp(13), dp(13))
            visibility = if (address.text.isEmpty()) INVISIBLE else VISIBLE
            setOnClickListener { address.text.clear(); address.requestFocus() }
        }
        input.addView(clear, LinearLayout.LayoutParams(dp(44), dp(44)).apply { marginEnd = dp(4) })
        column.full(input)
        column.space(8)
        val feedback = label(R.string.server_hint, 12f, muted).apply {
            accessibilityLiveRegion = ACCESSIBILITY_LIVE_REGION_POLITE
        }
        column.full(feedback)
        fun updateBorder() {
            input.background = rounded(surface, if (invalid) danger else if (address.hasFocus()) accent else line)
        }
        address.setOnFocusChangeListener { _, _ -> updateBorder() }
        address.doAfterTextChanged {
            clear.visibility = if (it.isNullOrEmpty()) INVISIBLE else VISIBLE
            if (invalid) {
                invalid = false
                feedback.setText(R.string.server_hint)
                feedback.setTextColor(muted)
                updateBorder()
            }
        }
        column.space(24)
        val connect = Button(context).apply {
            setText(R.string.server_connect)
            textSize = 15f
            typeface = Typeface.create("sans-serif-medium", Typeface.NORMAL)
            isAllCaps = false
            minHeight = dp(52)
            minimumHeight = dp(52)
            setPadding(dp(16), dp(12), dp(16), dp(12))
            setTextColor(Color.WHITE)
            background = ripple(accent)
            stateListAnimator = null
        }
        fun submit() {
            if (submitting) return
            val value = parseOrigin(address.text.toString())
            if (value == null) {
                invalid = true
                feedback.setText(if (address.text.isBlank()) R.string.server_empty else R.string.server_invalid)
                feedback.setTextColor(danger)
                address.requestFocus()
                updateBorder()
                return
            }
            submitting = true
            connect.isEnabled = false
            connect.setText(R.string.server_connecting)
            (context.getSystemService(Context.INPUT_METHOD_SERVICE) as InputMethodManager)
                .hideSoftInputFromWindow(windowToken, 0)
            onConnect(value)
        }
        connect.setOnClickListener { submit() }
        address.setOnEditorActionListener { _, action, _ ->
            if (action == EditorInfo.IME_ACTION_GO) { submit(); true } else false
        }
        column.full(connect)
        column.space(20)
        column.full(label(R.string.server_local, 12f, muted).apply { gravity = Gravity.CENTER })
    }

    fun goBack() {
        if (submitting) return
        (context.getSystemService(Context.INPUT_METHOD_SERVICE) as InputMethodManager)
            .hideSoftInputFromWindow(windowToken, 0)
        onBack()
    }
}
