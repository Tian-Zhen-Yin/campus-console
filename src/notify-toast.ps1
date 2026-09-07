param([string]$Title = '校招投递管理', [string]$Message = '')
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
$template = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
$template.GetElementsByTagName('text').Item(0).AppendChild($template.CreateTextNode($Title)) | Out-Null
$template.GetElementsByTagName('text').Item(1).AppendChild($template.CreateTextNode($Message)) | Out-Null
$toast = [Windows.UI.Notifications.ToastNotification]::new($template)
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('Campus Recruitment Console').Show($toast)
