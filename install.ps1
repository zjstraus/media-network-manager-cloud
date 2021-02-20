$services = Get-ChildItem -Directory

foreach ($service in $services) {
    cd $service
    npm install
    cd ..
}

write-host exit